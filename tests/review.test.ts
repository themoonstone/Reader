import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, AppError } from "../lib/store";
import { emptyDraft } from "../lib/contracts";
import { previewExcel, commitExcel } from "../lib/excel-import";
import { Review } from "../lib/review";
import { reviewInterval, type ReviewView } from "../lib/review-contracts";
import {
  exportBackup,
  validateBackup,
  previewRestore,
  commitRestore,
  readSnapshot,
} from "../lib/backup";
import { handle } from "../lib/http";
function fixture(n = 8, path = ":memory:") {
  let now = Date.parse("2026-10-17T03:00:00.000Z");
  const store = new Store(path, () => now),
    review = new Review(store);
  const source = store.createSource({
    id: randomUUID(),
    type: "Reading",
    title: "Review test",
  });
  const ids = Array.from({ length: n }, (_, i) => {
    const d = store.createDraft(randomUUID(), {
      ...emptyDraft("Reading", source.id),
      term: `term ${i}`,
      sentence: `A real sentence for term ${i}.`,
      meaning: `释义 ${i}`,
      priority: i % 2 ? "P2" : "P1",
    });
    return store.saveDraft(d.id, { version: 1 }).expressionId!;
  });
  const tab = randomUUID();
  let v: ReviewView = {
      session: null,
      card: null,
      feedbackCount: 0,
      results: { forgot: 0, hard: 0, remember: 0 },
    },
    token = "";
  const take = (next: ReviewView) => {
    v = next;
    if (next.leaseToken) token = next.leaseToken;
    return v;
  };
  const writer = (delta = 0) => ({
    owner_tab: tab,
    token,
    lease_version: v.lease?.version ?? 1,
    session_version: v.session!.version,
    delta_ms: delta,
  });
  const joinPool = (items = ids) =>
    review.add({
      operation_id: randomUUID(),
      expression_ids: items,
      expected_versions: Object.fromEntries(
        items.map((id) => [
          id,
          review.candidates("", 1).items.find((e) => e.id === id)?.entry
            ?.version ??
            Number(
              store.one(
                "SELECT version FROM review_entries WHERE expression_id=?",
                id,
              )?.version ?? 0,
            ),
        ]),
      ),
    });
  const start = (newLimit = 3, cardLimit = 5) =>
    take(
      review.start({
        owner_tab: tab,
        request_id: randomUUID(),
        budget_seconds: 600,
        card_limit: cardLimit,
        new_limit: newLimit,
      }),
    );
  const next = () =>
    take(review.next(v.session!.id, { ...writer(), request_id: randomUUID() }));
  const reveal = () =>
    take(
      review.reveal(v.card!.id, { ...writer(), card_version: v.card!.version }),
    );
  const feedback = (result = "remember") =>
    take(
      review.feedback(v.card!.id, {
        ...writer(),
        card_version: v.card!.version,
        result,
      }),
    );
  const skip = () =>
    take(
      review.skip(v.card!.id, { ...writer(), card_version: v.card!.version }),
    );
  const end = () =>
    take(review.state(v.session!.id, { ...writer(), action: "end" }));
  return {
    store,
    review,
    source,
    ids,
    tab,
    take,
    writer,
    joinPool,
    start,
    next,
    reveal,
    feedback,
    skip,
    end,
    get v() {
      return v;
    },
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
const isConflict = (e: unknown) => e instanceof AppError && e.status === 409;
test("Review interval schedule uses old stage, hard reduced stage, and forgot reset", () => {
  let stage = 0,
    at = 0;
  for (const days of [3, 7, 14, 30, 60, 90, 90]) {
    const r = reviewInterval(stage, "remember", at);
    assert.equal(Date.parse(r.eligibleAfter) - at, days * 86400000);
    stage = r.stage;
  }
  for (let s = 0; s <= 5; s++) {
    const r = reviewInterval(s, "hard", 0);
    assert.equal(r.stage, Math.max(0, s - 1));
    assert.equal(
      Date.parse(r.eligibleAfter),
      Math.max(1, Math.floor([3, 7, 14, 30, 60, 90][r.stage] / 2)) * 86400000,
    );
    assert.deepEqual(reviewInterval(s, "forgot", 0), {
      stage: 0,
      eligibleAfter: "1970-01-02T00:00:00.000Z",
    });
  }
});
test("Pool is opt-in, atomic capacity 20, idempotent and versioned; pause/resume/removal preserve introduction", () => {
  const f = fixture(22);
  try {
    assert.equal(f.review.pool().activeCount, 0);
    f.joinPool(f.ids.slice(0, 19));
    assert.throws(() => f.joinPool(f.ids.slice(19, 21)));
    assert.equal(f.review.pool().activeCount, 19);
    f.joinPool([f.ids[19]]);
    assert.throws(() => f.joinPool([f.ids[20]]));
    const e = f.review.pool().entries[0],
      op = {
        operation_id: randomUUID(),
        entry_version: e.version,
        action: "pause",
      };
    f.review.updatePool(e.id, op);
    f.review.updatePool(e.id, op);
    f.joinPool([f.ids[20]]);
    const paused = f.review.pool().entries.find((r) => r.id === e.id)!;
    assert.throws(() =>
      f.review.updatePool(e.id, {
        operation_id: randomUUID(),
        entry_version: paused.version,
        action: "resume",
      }),
    );
    assert.equal(f.review.pool().activeCount, 20);
    assert.equal(f.store.search().length, 22);
  } finally {
    f.store.close();
  }
});
test("Invalid material cannot join; edits atomically pause, restore never resumes; source archive only invalidates card", () => {
  const f = fixture(3);
  try {
    f.joinPool();
    f.start();
    f.next();
    const id = f.v.card!.expression_id;
    const x = f.store.expression(id);
    f.store.updateExpression(id, { ...x, priority: "P3" }, x.version);
    assert.equal(f.review.current().card!.state, "invalidated");
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === id)!.state,
      "paused",
    );
    const y = f.store.expression(id);
    f.store.updateExpression(id, { ...y, priority: "P1" }, y.version);
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === id)!.state,
      "paused",
    );
    const cid = f.ids.find((i) => i !== id)!,
      c = f.store.expression(cid).contexts[0];
    f.store.setContextDeleted(c.id, c.version, true);
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === cid)!.state,
      "paused",
    );
    f.store.setContextDeleted(
      c.id,
      f.store.expression(cid).contexts[0]?.version ?? 2,
      false,
    );
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === cid)!.state,
      "paused",
    );
    const other = f.ids.find((i) => i !== id && i !== cid)!;
    f.store.updateSource(f.source.id, f.source, f.source.version, "archived");
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === other)!.state,
      "active",
    );
  } finally {
    f.store.close();
  }
});
test("Recognition hides answers, requires reveal, snapshots survive edits; feedback retry and different result conflict", () => {
  const f = fixture();
  try {
    f.joinPool();
    f.start();
    f.next();
    assert.equal("answer" in f.v.card!, false);
    assert.equal("snapshot" in f.v.card!, false);
    assert.throws(() => f.feedback());
    f.reveal();
    assert.ok(f.v.card!.answer?.meaning);
    const request = {
        ...f.writer(),
        card_version: f.v.card!.version,
        result: "remember",
      },
      cid = f.v.card!.id;
    f.take(f.review.feedback(cid, request));
    assert.equal(f.v.feedbackCount, 1);
    f.review.feedback(cid, request);
    assert.equal(f.review.current().feedbackCount, 1);
    assert.throws(
      () => f.review.feedback(cid, { ...request, result: "forgot" }),
      isConflict,
    );
    const x = f.store.expression(f.v.card!.expression_id);
    f.store.updateExpression(
      x.id,
      { ...x, meaning: "changed meaning" },
      x.version,
    );
    assert.notEqual(
      JSON.parse(
        String(f.store.one("SELECT snapshot FROM review_records")!.snapshot),
      ).answer.meaning,
      "changed meaning",
    );
    assert.equal(f.store.expression(x.id).seen, 1);
    assert.equal(f.store.expression(x.id).used, 0);
  } finally {
    f.store.close();
  }
});
test("Issuance and start replay do not consume twice; skip counts, session and day new limits persist through rejoin", () => {
  const f = fixture(9);
  try {
    f.joinPool();
    const req = {
      owner_tab: f.tab,
      request_id: randomUUID(),
      budget_seconds: 600,
      card_limit: 5,
      new_limit: 3,
    };
    f.take(f.review.start(req));
    f.review.start(req);
    const issue = { ...f.writer(), request_id: randomUUID() };
    f.take(f.review.next(f.v.session!.id, issue));
    const cid = f.v.card!.id;
    f.review.next(f.v.session!.id, issue);
    assert.equal(f.review.current().session!.issued_count, 1);
    f.skip();
    for (let i = 0; i < 2; i++) {
      f.next();
      assert.notEqual(f.v.card!.id, cid);
      f.skip();
    }
    f.next();
    assert.equal(f.v.session!.state, "ended");
    assert.equal(f.v.session!.issued_count, 3);
    f.start(5, 10);
    let count = 0;
    while (f.v.session!.state !== "ended") {
      f.next();
      if (f.v.session!.state !== "ended") {
        f.skip();
        count++;
      }
    }
    assert.equal(count, 5);
    assert.equal(f.v.session!.introduced_count, 2);
    assert.equal(
      f.store.one(
        "SELECT count(*) AS n FROM review_cards WHERE is_first_presentation=1",
      )!.n,
      5,
    );
    const first = f.review.pool().entries.find((e) => e.first_presented_at)!;
    f.review.updatePool(first.id, {
      operation_id: randomUUID(),
      entry_version: first.version,
      action: "remove",
    });
    f.joinPool([first.expression_id]);
    assert.equal(
      f.review.pool().entries.find((e) => e.id === first.id)!
        .first_presented_at,
      first.first_presented_at,
    );
  } finally {
    f.store.close();
  }
});
test("No cooling fill and new=0; last of five cards may answer exactly once; old shown rotates before fresh", () => {
  const f = fixture(6);
  try {
    f.joinPool();
    f.start(0);
    f.next();
    assert.equal(f.v.session!.issued_count, 0);
    assert.equal(f.v.session!.end_reason, "no_candidates");
    f.start(5);
    for (let i = 0; i < 5; i++) {
      f.next();
      f.reveal();
      f.feedback("remember");
    }
    assert.equal(f.v.session!.end_reason, "card_limit");
    assert.equal(f.v.feedbackCount, 5);
    f.start(0);
    f.next();
    assert.equal(f.v.session!.issued_count, 0);
    f.advance(30 * 86400000);
    f.start(0);
    f.next();
    assert.equal(f.v.card!.is_first_presentation, 0);
    f.skip();
    f.next();
    assert.equal(f.v.session!.issued_count, 2);
  } finally {
    f.store.close();
  }
});
test("Time boundary accounts final delta atomically, blocks feedback, permits readonly reveal; time is bounded by wall clock", () => {
  const f = fixture();
  try {
    f.joinPool();
    f.start();
    f.next();
    f.take(f.review.heartbeat(f.v.session!.id, { ...f.writer(5000) }));
    assert.equal(f.v.session!.active_elapsed_ms, 0);
    for (let i = 0; i < 119; i++) {
      f.advance(5000);
      f.take(f.review.heartbeat(f.v.session!.id, f.writer(5000)));
    }
    assert.equal(f.v.session!.active_elapsed_ms, 595000);
    f.advance(5000);
    f.take(
      f.review.reveal(f.v.card!.id, {
        ...f.writer(5000),
        card_version: f.v.card!.version,
      }),
    );
    assert.equal(f.v.session!.end_reason, "time_limit");
    assert.ok(f.v.card!.answer);
    assert.equal(f.store.one("SELECT count(*) AS n FROM review_records")!.n, 0);
    const stable = f.store.one(
      "SELECT * FROM review_entries WHERE id=?",
      f.v.card!.entry_id,
    );
    f.take(f.review.reveal(f.v.card!.id, { card_version: f.v.card!.version }));
    assert.ok(f.v.card!.answer);
    assert.deepEqual(
      f.store.one(
        "SELECT * FROM review_entries WHERE id=?",
        f.v.card!.entry_id,
      ),
      stable,
    );
    assert.throws(() => f.feedback(), isConflict);
  } finally {
    f.store.close();
  }
});
test("Expired/restarted leases pause without catchup; another tab cannot steal, stale writer rejected, explicit resume required", () => {
  const f = fixture();
  try {
    f.joinPool();
    f.start();
    f.next();
    const old = f.writer();
    assert.throws(
      () =>
        f.review.claim(f.v.session!.id, {
          owner_tab: randomUUID(),
          lease_version: 1,
          session_version: f.v.session!.version,
        }),
      isConflict,
    );
    f.advance(20000);
    f.take(f.review.current());
    assert.equal(f.v.session!.state, "paused");
    assert.equal(f.v.session!.active_elapsed_ms, 0);
    assert.throws(() => f.review.heartbeat(f.v.session!.id, old), isConflict);
    const other = randomUUID();
    f.take(
      f.review.claim(f.v.session!.id, {
        owner_tab: other,
        lease_version: 0,
        session_version: f.v.session!.version,
      }),
    );
    assert.equal(f.v.session!.state, "running");
    assert.throws(() => f.review.heartbeat(f.v.session!.id, old), isConflict);
    assert.throws(() => f.start(), isConflict);
  } finally {
    f.store.close();
  }
});
test("Schema 3 roundtrip includes feedback and paused position; schema2 conversion warns, generations and snapshots protect restore", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-review-backup-")),
    f = fixture(3, join(dir, "db.sqlite"));
  try {
    f.joinPool();
    f.start();
    f.next();
    f.reveal();
    f.feedback();
    f.next();
    const b = exportBackup(f.store);
    assert.equal(b.schema_version, 3);
    validateBackup(b);
    const p = previewRestore(f.store, b),
      gen = f.store.generation;
    commitRestore(f.store, p.token, true);
    assert.notEqual(f.store.generation, gen);
    assert.equal(f.review.current().session!.state, "paused");
    assert.equal(f.store.one("SELECT count(*) AS n FROM review_leases")!.n, 0);
    const after = exportBackup(f.store);
    assert.deepEqual(after.review_entries, b.review_entries);
    assert.deepEqual(after.review_cards, b.review_cards);
    assert.deepEqual(after.review_records, b.review_records);
    const {
      review_entries,
      review_sessions,
      review_cards,
      review_records,
      ...base
    } = b;
    const legacy = { ...base, schema_version: 2 };
    const preview = previewRestore(f.store, legacy);
    assert.match(preview.warning, /清除/);
    assert.equal(f.review.pool().activeCount, 3);
    const snap = readSnapshot(f.store, preview.snapshot);
    assert.equal(snap.review_entries.length, 3);
    commitRestore(f.store, preview.token, true);
    assert.equal(f.review.pool().entries.length, 0);
    assert.equal(f.store.search().length, 3);
    assert.throws(() => validateBackup({ ...b, schema_version: 99 }));
    const bad = structuredClone(b);
    bad.review_cards[0].entry_id = randomUUID();
    assert.throws(() => validateBackup(bad));
    const badDate = structuredClone(b);
    badDate.review_cards[0].presented_local_date = "2026-99-99";
    assert.throws(() => validateBackup(badDate));
    const badCount = structuredClone(b);
    badCount.review_sessions[0].issued_count++;
    assert.throws(() => validateBackup(badCount));
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Schema2 migration preserves original business rows and creates readable preupgrade snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-review-migration-")),
    file = join(dir, "db.sqlite"),
    f = fixture(2, file);
  let store: Store | undefined;
  try {
    const before = exportBackup(f.store);
    f.store.close();
    const old = new DatabaseSync(file);
    old.exec(
      "DROP TABLE review_leases;DROP TABLE review_records;DROP TABLE review_cards;DROP TABLE review_sessions;DROP TABLE review_entries;PRAGMA user_version=2",
    );
    old.close();
    store = new Store(file);
    const after = exportBackup(store);
    for (const key of ["sources", "expressions", "contexts", "drafts"] as const)
      assert.deepEqual(after[key], before[key]);
    assert.equal(after.review_entries.length, 0);
    const name = readdirSync(store.snapshotDir).find((n) =>
      n.startsWith("before-schema-v3"),
    )!;
    assert.ok(name);
    const snap = new DatabaseSync(join(store.snapshotDir, name), {
      readOnly: true,
    });
    assert.equal(snap.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(
      snap.prepare("SELECT count(*) AS n FROM expressions").get()!.n,
      2,
    );
    snap.close();
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Review HTTP guards origin/generation and answer payload, API failures are transactional", async () => {
  const f = fixture(2);
  try {
    const req = (
      path: string,
      body?: unknown,
      generation = f.store.generation,
    ) =>
      handle(
        new Request(`http://localhost:3000/api/${path}`, {
          method: body ? "POST" : "GET",
          headers: body
            ? {
                origin: "http://localhost:3000",
                "content-type": "application/json",
                "X-ReadWords-Generation": generation,
              }
            : {},
          body: body ? JSON.stringify(body) : undefined,
        }),
        path.split("/"),
        f.store,
      );
    f.joinPool();
    const started = await req("review/sessions", {
      owner_tab: f.tab,
      request_id: randomUUID(),
      budget_seconds: 600,
      card_limit: 5,
      new_limit: 3,
    });
    assert.equal(started.status, 200);
    f.take(await started.json());
    const r = await req(`review/sessions/${f.v.session!.id}/next`, {
      ...f.writer(),
      request_id: randomUUID(),
    });
    assert.equal(r.status, 200);
    const payload = await r.json();
    assert.equal(JSON.stringify(payload).includes("释义"), false);
    assert.equal("answer" in payload.card, false);
    const stale = await req(
      `review/cards/${payload.card.id}/feedback`,
      { ...f.writer(), card_version: 1, result: "remember" },
      randomUUID(),
    );
    assert.equal(stale.status, 409);
    assert.equal(f.store.one("SELECT count(*) AS n FROM review_records")!.n, 0);
  } finally {
    f.store.close();
  }
});

test("Cross-midnight issuance records server local date/timezone and uses the new date quota within the same session", () => {
  const f = fixture(8);
  try {
    const late = new Date(f.now());
    late.setHours(23, 59, 50, 0);
    f.advance(late.getTime() - f.now());
    f.joinPool();
    f.start(5, 10);
    for (let i = 0; i < 3; i++) {
      f.next();
      f.skip();
    }
    const firstDate = f.v.card!.presented_local_date;
    f.advance(20000);
    f.take(f.review.current());
    assert.equal(f.v.session!.state, "paused");
    f.take(
      f.review.claim(f.v.session!.id, {
        owner_tab: f.tab,
        lease_version: 0,
        session_version: f.v.session!.version,
      }),
    );
    for (let i = 0; i < 2; i++) {
      f.next();
      assert.notEqual(f.v.card!.presented_local_date, firstDate);
      assert.equal(
        f.v.card!.presented_timezone,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      f.skip();
    }
    f.next();
    assert.equal(f.v.session!.state, "ended");
    f.start(5, 20);
    while (f.v.session!.state !== "ended") {
      const next = f.next();
      if (next.session!.state !== "ended") f.skip();
    }
    const facts = f.store.all(
      "SELECT presented_local_date,count(*) AS n FROM review_cards WHERE is_first_presentation=1 GROUP BY presented_local_date ORDER BY presented_local_date",
    );
    assert.deepEqual(
      facts.map((r) => Number(r.n)),
      [3, 5],
    );
  } finally {
    f.store.close();
  }
});
test("Invalid joins, stale pool replay, feedback/skip competition and late transaction failure leave no partial updates", () => {
  const f = fixture(3);
  try {
    const op = {
      operation_id: randomUUID(),
      expression_ids: [f.ids[0]],
      expected_versions: { [f.ids[0]]: 0 },
    };
    f.review.add(op);
    const e = f.review.pool().entries[0];
    f.review.updatePool(e.id, {
      operation_id: randomUUID(),
      entry_version: e.version,
      action: "pause",
    });
    assert.throws(() => f.review.add(op), isConflict);
    assert.equal(f.review.pool().activeCount, 0);
    const x = f.store.expression(f.ids[1]);
    f.store.updateExpression(x.id, { ...x, priority: "P3" }, x.version);
    assert.throws(() => f.joinPool([f.ids[0], f.ids[1]]));
    assert.equal(f.review.pool().activeCount, 0);
    f.joinPool([f.ids[0], f.ids[2]]);
    f.start();
    f.next();
    f.reveal();
    const state = exportBackup(f.store);
    f.store.db.exec(
      "CREATE TRIGGER review_fail BEFORE UPDATE ON review_entries WHEN NEW.last_reviewed_at IS NOT OLD.last_reviewed_at BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    assert.throws(() => f.feedback());
    const failed = exportBackup(f.store);
    for (const k of [
      "review_entries",
      "review_sessions",
      "review_cards",
      "review_records",
    ] as const)
      assert.deepEqual(failed[k], state[k]);
    f.store.db.exec("DROP TRIGGER review_fail");
    f.skip();
    assert.throws(() => f.feedback(), isConflict);
    assert.equal(f.review.current().feedbackCount, 0);
    f.next();
    f.reveal();
    f.feedback("forgot");
    assert.throws(() => f.skip(), isConflict);
    assert.equal(f.review.current().feedbackCount, 1);
  } finally {
    f.store.close();
  }
});
test("Previously shown older P2 precedes recently shown P1, contexts rotate, and a long absence creates no extra tasks", () => {
  const f = fixture(3);
  try {
    f.joinPool();
    f.start(3);
    for (let i = 0; i < 3; i++) {
      f.next();
      f.skip();
      f.advance(1000);
    }
    f.end();
    const oldest = f.store.one(
      "SELECT * FROM review_entries ORDER BY last_presented_at LIMIT 1",
    )!;
    const x = f.store.expression(String(oldest.expression_id));
    f.store.updateExpression(x.id, { ...x, priority: "P2" }, x.version);
    const d = f.store.createDraft(randomUUID(), {
      ...emptyDraft("Reading", f.source.id),
      term: x.term,
      meaning: "另一语境",
      sentence: "A second sentence.",
      priority: "P2",
    });
    f.store.saveDraft(d.id, { version: 1, expressionId: x.id });
    f.advance(30 * 86400000);
    f.start(0);
    f.next();
    assert.equal(f.v.card!.expression_id, x.id);
    assert.equal(f.v.card!.front.sentence, "A second sentence.");
    f.skip();
    while (f.v.session!.state !== "ended") {
      const next = f.next();
      if (next.session!.state !== "ended") f.skip();
    }
    assert.equal(f.v.session!.issued_count, 3);
  } finally {
    f.store.close();
  }
});
test("Corrected Writing never uses erroneous original sentence; failed writing without adopted correction is ineligible", () => {
  const f = fixture(0);
  try {
    const s = f.store.createSource({
      id: randomUUID(),
      type: "Writing",
      title: "Writing",
    });
    const d = f.store.createDraft(randomUUID(), {
        ...emptyDraft("Writing", s.id),
        term: "make a decision",
        meaning: "作决定",
        priority: "P1",
        eventKind: "output_corrected",
        sentence: "I do a decision.",
        originalExpression: "do a decision",
        correctedExpression: "make a decision",
      }),
      id = f.store.saveDraft(d.id, { version: 1 }).expressionId!;
    assert.throws(() => f.joinPool([id]));
    const c = f.store.expression(id).contexts[0];
    f.store.updateContext(
      c.id,
      { ...c.data, correctedSentence: "I make a decision." },
      c.version,
      id,
    );
    f.joinPool([id]);
    f.start();
    f.next();
    assert.equal(f.v.card!.front.sentence, "I make a decision.");
    assert.equal(JSON.stringify(f.v).includes("I do a decision."), false);
  } finally {
    f.store.close();
  }
});
test("Context reparenting invalidates current card without migrating pool/history; deleted and restored expression stays paused", () => {
  const f = fixture(2);
  try {
    f.joinPool();
    f.start();
    f.next();
    const original = f.v.card!.expression_id,
      other = f.ids.find((id) => id !== original)!,
      c = f.store.expression(original).contexts[0];
    f.store.updateContext(c.id, c.data, c.version, other);
    assert.equal(f.review.current().card!.state, "invalidated");
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === original)!.state,
      "paused",
    );
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === other)!
        .first_presented_at,
      null,
    );
    f.take(f.review.current());
    f.next();
    f.reveal();
    f.feedback();
    const x = f.store.expression(other);
    f.store.deleteExpression(x.id, x.version);
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === other)!.state,
      "paused",
    );
    f.store.restoreExpression(other, f.store.expression(other).version);
    assert.equal(
      f.review.pool().entries.find((e) => e.expression_id === other)!.state,
      "paused",
    );
    validateBackup(exportBackup(f.store));
  } finally {
    f.store.close();
  }
});
test("Service restart pauses a running session, clears runtime lease; failed migration rolls back tables and original schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-review-restart-")),
    file = join(dir, "db.sqlite"),
    f = fixture(1, file);
  let store: Store | undefined;
  try {
    f.joinPool();
    f.start();
    f.next();
    f.store.db
      .prepare("UPDATE review_leases SET process_id='previous-service-process'")
      .run();
    f.store.close();
    store = new Store(file);
    assert.equal(new Review(store).current().session!.state, "paused");
    assert.equal(store.one("SELECT count(*) AS n FROM review_leases")!.n, 0);
    store.close();
    store = undefined;
    const old = new DatabaseSync(file);
    old.exec(
      "DROP TABLE review_leases;DROP TABLE review_records;DROP TABLE review_cards;DROP TABLE review_sessions;DROP TABLE review_entries;CREATE VIEW review_entries AS SELECT id FROM expressions;PRAGMA user_version=2",
    );
    old.close();
    assert.throws(() => new Store(file));
    const check = new DatabaseSync(file);
    assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 2);
    assert.equal(
      check
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name='review_sessions'",
        )
        .get()!.n,
      0,
    );
    assert.equal(
      check.prepare("SELECT count(*) AS n FROM expressions").get()!.n,
      1,
    );
    check.close();
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const realBooks = [
  "resources/bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx",
  "resources/Our_Little_Farm_Vocabulary-4.xlsx",
];
test(
  "Both actual workbooks stay outside pool until opt-in; Recognition uses saved original, Farm K remains answer-only auxiliary",
  { skip: realBooks.some((p) => !existsSync(p)) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-real-review-migration-"));
    const f = fixture(1, join(dir, "db.sqlite"));
    const manual = f.store.expression(f.ids[0]);
    f.store.updateExpression(
      manual.id,
      { ...manual, priority: "P2" },
      manual.version,
    );
    try {
      for (const file of realBooks) {
        const p = await previewExcel(
          readFileSync(file),
          file.split("/").pop()!,
          f.store,
        );
        commitExcel(f.store, {
          token: p.token,
          title: p.suggestedTitle,
          confirmed: true,
          choices: p.groups.map((g) => ({ groupKey: g.key, action: "new" })),
        });
      }
      assert.equal(f.review.pool().activeCount, 0);
      assert.equal(f.store.one("SELECT count(*) AS n FROM review_cards")!.n, 0);
      const rows = f.store.search();
      const samples = realBooks.map((_, i) =>
        rows.find((e) =>
          e.contexts.some(
            (c) =>
              c.data.importMetadata?.profile ===
                (i ? "little-farm-v1" : "bebe-strict-v1") && c.data.sentence,
          ),
        )!,
      );
      const before = exportBackup(f.store);
      f.store.db.exec(
        "DROP TABLE review_leases;DROP TABLE review_records;DROP TABLE review_cards;DROP TABLE review_sessions;DROP TABLE review_entries;PRAGMA user_version=2",
      );
      const migrated = new Store(f.store.path);
      try {
        const result = exportBackup(migrated);
        for (const key of [
          "sources",
          "expressions",
          "contexts",
          "drafts",
        ] as const)
          assert.deepEqual(result[key], before[key]);
        assert.equal(result.review_entries.length, 0);
      } finally {
        migrated.close();
      }

      f.joinPool(samples.map((e) => e.id));
      f.start();
      for (let i = 0; i < 2; i++) {
        f.next();
        const c = f.store.context(f.v.card!.context_id);
        assert.equal(f.v.card!.front.sentence, c.data.sentence);
        assert.equal("answer" in f.v.card!, false);
        f.reveal();
        assert.equal(f.v.card!.answer!.contextLanguage, "en");
        assert.equal(
          f.v.card!.answer!.simpleParaphrase,
          c.data.importMetadata?.simpleParaphrase || "",
        );
        f.feedback();
      }
      const after = exportBackup(f.store);
      for (const key of [
        "sources",
        "expressions",
        "contexts",
        "drafts",
      ] as const)
        assert.deepEqual(after[key], before[key]);
      f.end();
      const farm = samples[1],
        context = f.store.expression(farm.id).contexts[0];
      f.store.updateContext(
        context.id,
        { ...context.data, meaning: "用户改写的中文语境义" },
        context.version,
        farm.id,
      );
      const bebeEntry = f.review
        .pool()
        .entries.find((e) => e.expression_id === samples[0].id)!;
      f.review.updatePool(bebeEntry.id, {
        operation_id: randomUUID(),
        entry_version: bebeEntry.version,
        action: "pause",
      });
      f.advance(3 * 86400000);
      f.start(0);
      f.next();
      f.reveal();
      assert.equal(f.v.card!.answer!.contextLanguage, "user");
      assert.equal(f.v.card!.answer!.contextMeaning, "用户改写的中文语境义");
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("The feedback transaction first accepts the final time delta and refuses a new record at exactly the budget", () => {
  const f = fixture(1);
  try {
    f.joinPool();
    f.start();
    f.next();
    const reveal = { ...f.writer(), card_version: f.v.card!.version };
    f.take(f.review.reveal(f.v.card!.id, reveal));
    const rev = f.v.card!.version;
    f.take(f.review.reveal(f.v.card!.id, reveal));
    assert.equal(f.v.card!.version, rev);
    for (let i = 0; i < 119; i++) {
      f.advance(5000);
      f.take(f.review.heartbeat(f.v.session!.id, f.writer(5000)));
    }
    f.advance(5000);
    f.take(
      f.review.feedback(f.v.card!.id, {
        ...f.writer(5000),
        card_version: f.v.card!.version,
        result: "remember",
      }),
    );
    assert.equal(f.v.session!.active_elapsed_ms, 600000);
    assert.equal(f.v.session!.end_reason, "time_limit");
    assert.equal(f.v.feedbackCount, 0);
    assert.equal(f.store.one("SELECT stage FROM review_entries")!.stage, 0);
    assert.equal(
      f.store.one("SELECT eligible_after FROM review_entries")!.eligible_after,
      null,
    );
  } finally {
    f.store.close();
  }
});
test("Concurrent API issuance with different ids and same version cannot double-spend quotas", async () => {
  const f = fixture(3);
  try {
    f.joinPool();
    f.start();
    const sid = f.v.session!.id,
      base = f.writer();
    const req = (request_id: string) =>
      handle(
        new Request(`http://localhost:3000/api/review/sessions/${sid}/next`, {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            "X-ReadWords-Generation": f.store.generation,
          },
          body: JSON.stringify({ ...base, request_id }),
        }),
        ["review", "sessions", sid, "next"],
        f.store,
      );
    const responses = await Promise.all([req(randomUUID()), req(randomUUID())]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.review.current().session!.issued_count, 1);
    assert.equal(f.review.current().session!.introduced_count, 1);
    assert.equal(f.store.one("SELECT count(*) AS n FROM review_cards")!.n, 1);
  } finally {
    f.store.close();
  }
});
