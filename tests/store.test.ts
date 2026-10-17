import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, AppError } from "../lib/store";
import {
  emptyDraft,
  normalize,
  parseTimestamp,
  validDate,
  type DraftInput,
} from "../lib/contracts";
import { handle } from "../lib/http";

function fixture() {
  const store = new Store(":memory:");
  const source = store.createSource({
    id: randomUUID(),
    type: "Reading",
    title: "Slow Down",
  });
  const data: DraftInput = {
    ...emptyDraft(),
    term: "carve out",
    sourceId: source.id,
    sentence: "I carve out some time every morning.",
    meaning: "专门腾出时间",
    priority: "P1",
  };
  return { store, source, data };
}
test("normalization preserves punctuation and word forms; date/time parsing rejects invalid values", () => {
  assert.equal(normalize("  CARVE   out "), "carve out");
  assert.notEqual(normalize("carved out"), normalize("carve out"));
  assert.notEqual(normalize("all right?"), normalize("all right"));
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2026-99-01"), false);
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(parseTimestamp("03:42"), 222);
  assert.equal(parseTimestamp("01:03:42"), 3822);
  assert.throws(() => parseTimestamp("01:60:00"));
  assert.throws(() => parseTimestamp("99:99"));
});
test("four source types and minimal draft survive file-backed database reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "readwords-unit-"));
  const file = join(dir, "db.sqlite");
  let store = new Store(file);
  try {
    for (const type of ["Reading", "Listening", "Writing", "Manual"]) {
      store.createSource({ id: randomUUID(), type, title: `${type} source` });
    }
    const d = store.createDraft(randomUUID(), {
      term: "reluctant",
      sourceType: "Manual",
    });
    store.close();
    store = new Store(file);
    assert.equal(store.sources().length, 4);
    assert.equal(store.getDraft(d.id).data.term, "reluctant");
    assert.equal(store.search().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("capture and save are idempotent; appending context preserves priority and meaning", () => {
  const { store, data } = fixture();
  try {
    const id = randomUUID();
    const draft = store.createDraft(id, data);
    assert.equal(store.createDraft(id, data).id, id);
    assert.equal(store.drafts().length, 1);
    const saved = store.saveDraft(id, { version: draft.version });
    assert.deepEqual(store.saveDraft(id, { version: 1 }), {
      expressionId: saved.expressionId,
      replay: true,
    });
    const second = store.createDraft(randomUUID(), {
      ...data,
      term: " CARVE   OUT ",
      priority: "P2",
      meaning: "在这里留出",
      sentence: "We carve out a space.",
    });
    assert.throws(
      () => store.saveDraft(second.id, { version: 1 }),
      (e) => e instanceof AppError && e.code === "CHOOSE_SENSE",
    );
    store.saveDraft(second.id, {
      version: 1,
      expressionId: saved.expressionId!,
    });
    const expression = store.expression(saved.expressionId!);
    assert.equal(expression.contextCount, 2);
    assert.equal(expression.seen, 2);
    assert.equal(expression.used, 0);
    assert.equal(expression.priority, "P1");
    assert.equal(expression.meaning, data.meaning);
    assert.equal(store.search().length, 1);
  } finally {
    store.close();
  }
});
test("homographs require explicit new sense and duplicate encounter requires confirmation", () => {
  const { store, data } = fixture();
  try {
    const first = store.createDraft(randomUUID(), data);
    const saved = store.saveDraft(first.id, { version: 1 });
    const second = store.createDraft(randomUUID(), data);
    assert.throws(
      () =>
        store.saveDraft(second.id, {
          version: 1,
          expressionId: saved.expressionId!,
        }),
      (e) => e instanceof AppError && e.code === "DUPLICATE_CONTEXT",
    );
    store.saveDraft(second.id, {
      version: 1,
      expressionId: saved.expressionId!,
      allowDuplicate: true,
    });
    assert.equal(store.expression(saved.expressionId!).contextCount, 2);
    const other = store.createDraft(randomUUID(), {
      ...data,
      meaning: "另一个义项",
    });
    store.saveDraft(other.id, { version: 1, newSense: true });
    assert.equal(store.candidates(data.term).length, 2);
  } finally {
    store.close();
  }
});
test("writing correction is not Used; explicit self-use increments Used", () => {
  const { store } = fixture();
  try {
    const s = store.createSource({
      id: randomUUID(),
      type: "Writing",
      title: "Journal",
    });
    const input = {
      ...emptyDraft("Writing", s.id),
      term: "drain my energy",
      meaning: "消耗精力",
      eventKind: "output_corrected",
      originalExpression: "cost my energy",
      correctedExpression: "drain my energy",
      correctedSentence: "The commute drains my energy.",
    };
    const d = store.createDraft(randomUUID(), input);
    const result = store.saveDraft(d.id, { version: 1 });
    assert.equal(store.expression(result.expressionId!).used, 0);
    assert.equal(store.expression(result.expressionId!).seen, 0);
    const used = store.createDraft(randomUUID(), {
      ...input,
      eventKind: "output_used",
      sentence: "It drains my energy.",
    });
    store.saveDraft(used.id, {
      version: 1,
      expressionId: result.expressionId!,
    });
    assert.equal(store.expression(result.expressionId!).used, 1);
  } finally {
    store.close();
  }
});
test("transaction failure never leaves a half-created expression/context or marks draft saved", () => {
  const { store, data } = fixture();
  try {
    const draft = store.createDraft(randomUUID(), data);
    store.db.exec(
      "CREATE TRIGGER fail_context BEFORE INSERT ON contexts BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
    );
    assert.throws(() => store.saveDraft(draft.id, { version: 1 }));
    assert.equal(store.search().length, 0);
    assert.equal(store.getDraft(draft.id).state, "pending");
    assert.equal(store.all("SELECT * FROM contexts").length, 0);
    store.db.exec("DROP TRIGGER fail_context");
    store.saveDraft(draft.id, { version: 1 });
    assert.equal(store.search().length, 1);
  } finally {
    store.close();
  }
});
test("optimistic locking, ignore/restore and archived source constraints", () => {
  const { store, data, source } = fixture();
  try {
    const d = store.createDraft(randomUUID(), data);
    const edited = store.updateDraft(d.id, { ...data, note: "first" }, 1);
    assert.throws(
      () => store.updateDraft(d.id, { ...data, note: "lost update" }, 1),
      (e) => e instanceof AppError && e.status === 409,
    );
    assert.equal(store.getDraft(d.id).data.note, "first");
    const ignored = store.updateDraft(d.id, edited.data, 2, "ignored");
    assert.throws(() => store.saveDraft(d.id, { version: ignored.version }));
    const restored = store.updateDraft(
      d.id,
      edited.data,
      ignored.version,
      "pending",
    );
    store.updateSource(source.id, source, source.version, "archived");
    assert.throws(() => store.saveDraft(d.id, { version: restored.version }));
    assert.equal(store.getDraft(d.id).state, "pending");
  } finally {
    store.close();
  }
});
test("required confirmation fields, source type, reason and listening timestamp validated before write", () => {
  const { store, data } = fixture();
  try {
    const noMeaning = store.createDraft(randomUUID(), { ...data, meaning: "" });
    assert.throws(() => store.saveDraft(noMeaning.id, { version: 1 }));
    const other = store.createDraft(randomUUID(), {
      ...data,
      whySaved: "other",
    });
    assert.throws(() => store.saveDraft(other.id, { version: 1 }));
    assert.throws(() =>
      store.createDraft(randomUUID(), { ...data, sourceType: "Listening" }),
    );
    const s = store.createSource({
      id: randomUUID(),
      type: "Listening",
      title: "Podcast",
      duration: 60,
    });
    const d = store.createDraft(randomUUID(), {
      ...data,
      sourceType: "Listening",
      sourceId: s.id,
      timestamp: "03:42",
    });
    assert.throws(() => store.saveDraft(d.id, { version: 1 }));
    assert.equal(store.search().length, 0);
  } finally {
    store.close();
  }
});
test("search covers Chinese meaning, sentence, source and exact/prefix ranks without duplicating expressions", () => {
  const { store, data } = fixture();
  try {
    const a = store.createDraft(randomUUID(), data);
    const first = store.saveDraft(a.id, { version: 1 });
    const b = store.createDraft(randomUUID(), {
      ...data,
      term: "carve",
      meaning: "雕刻",
    });
    store.saveDraft(b.id, { version: 1 });
    assert.equal(store.search("CARVE OUT")[0].id, first.expressionId);
    assert.equal(store.search("腾出").length, 1);
    assert.equal(store.search("Slow Down").length, 2);
    assert.equal(store.search("every morning").length, 2);
    assert.equal(store.search("", "Manual").length, 0);
    assert.equal(store.search("", "", "P3").length, 0);
  } finally {
    store.close();
  }
});
test("API rejects cross-site, missing origin, remote hosts, malformed JSON and non-JSON writes", async () => {
  const { store } = fixture();
  try {
    const req = (
      origin?: string,
      type = "application/json",
      body = "{}",
      host = "127.0.0.1:3000",
    ) =>
      new Request(`http://${host}/api/sources`, {
        method: "POST",
        headers: {
          ...(origin ? { Origin: origin } : {}),
          "Content-Type": type,
        },
        body,
      });
    assert.equal(
      (await handle(req("https://evil.example"), ["sources"], store)).status,
      403,
    );
    assert.equal((await handle(req(), ["sources"], store)).status, 403);
    assert.equal(
      (
        await handle(
          req("http://remote.test", "application/json", "{}", "remote.test"),
          ["sources"],
          store,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handle(
          req("http://127.0.0.1:3000", "text/plain"),
          ["sources"],
          store,
        )
      ).status,
      415,
    );
    assert.equal(
      (
        await handle(
          req("http://127.0.0.1:3000", "application/json", "{"),
          ["sources"],
          store,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await handle(
          req("http://127.0.0.1:3000", "application/json", "null"),
          ["sources"],
          store,
        )
      ).status,
      400,
    );
    const reconstructed = new Request("http://localhost:3000/api/sources", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:3000",
        Origin: "http://127.0.0.1:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: randomUUID(),
        type: "Manual",
        title: "Local host",
      }),
    });
    assert.equal((await handle(reconstructed, ["sources"], store)).status, 200);
    const badHost = new Request("http://localhost:3000/api/sources", {
      headers: { Host: "evil.example" },
    });
    assert.equal((await handle(badHost, ["sources"], store)).status, 403);
    const ok = await handle(
      new Request("http://127.0.0.1:3000/api/sources"),
      ["sources"],
      store,
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
  } finally {
    store.close();
  }
});
