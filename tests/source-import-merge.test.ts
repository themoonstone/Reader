import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { Store } from "../lib/store";
import { emptyDraft } from "../lib/contracts";
import { Review } from "../lib/review";
import type { ReviewView } from "../lib/review-contracts";
import {
  exportBackup,
  validateBackup,
  snapshots,
  readSnapshot,
} from "../lib/backup";
import { previewSourceMerge, commitSourceMerge } from "../lib/source-merge";
import {
  previewExcel,
  previewImportDiff,
  commitExcel,
} from "../lib/excel-import";
import { hashValue, materialState } from "../lib/change-preview";
import type { ImportPreview, ImportChoice } from "../lib/import-contracts";
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-source-merge-"));
  const s = new Store(join(dir, "db.sqlite"));
  return {
    s,
    dir,
    close() {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
function source(s: Store, title = "Book", extra: object = {}) {
  return s.createSource({ id: randomUUID(), type: "Reading", title, ...extra });
}
function save(
  s: Store,
  sid: string,
  sentence = "We carve out time.",
  eid?: string,
) {
  const d = s.createDraft(randomUUID(), {
    ...emptyDraft("Reading", sid),
    term: "carve out",
    sentence,
    meaning: "腾出时间",
    priority: "P1",
  });
  return s.saveDraft(d.id, {
    version: d.version,
    expressionId: eid,
    newSense: true,
  }).expressionId!;
}
function history(s: Store, eid: string) {
  const review = new Review(s),
    tab = randomUUID();
  review.add({
    operation_id: randomUUID(),
    expression_ids: [eid],
    expected_versions: { [eid]: 0 },
  });
  let v: ReviewView = review.start({
    owner_tab: tab,
    request_id: randomUUID(),
    budget_seconds: 600,
    card_limit: 5,
    new_limit: 3,
  });
  const token = v.leaseToken!;
  const writer = () => ({
    owner_tab: tab,
    token,
    lease_version: v.lease!.version,
    session_version: v.session!.version,
    delta_ms: 0,
  });
  v = review.next(v.session!.id, { ...writer(), request_id: randomUUID() });
  v = review.reveal(v.card!.id, { ...writer(), card_version: v.card!.version });
  v = review.feedback(v.card!.id, {
    ...writer(),
    card_version: v.card!.version,
    result: "remember",
  });
  review.state(v.session!.id, { ...writer(), action: "end" });
}
const record = (s: Store) =>
  hashValue(s.all("SELECT * FROM review_records ORDER BY id"));
const rows = [
  [
    "carve out",
    "phrase",
    "腾出",
    "set aside time",
    "We carve out time.",
    "P1",
    "理由",
    "target",
  ],
  [
    "carve out",
    "phrase",
    "腾出",
    "make room",
    "We carve out space.",
    "P1",
    "理由",
    "target",
  ],
];
async function book(values: string[][] = rows) {
  const w = new ExcelJS.Workbook(),
    sheet = w.addWorksheet("Chapter 1");
  sheet.addRow([
    "Circled item",
    "Type",
    "Dictionary / core Chinese meaning",
    "Meaning in this context (English)",
    "Sentence / context",
    "复习优先级（严格版）",
    "分级理由（语义复核）",
    "复习目标或搭配",
  ]);
  for (const r of values) sheet.addRow(r);
  return Buffer.from(await w.xlsx.writeBuffer());
}
function input(p: ImportPreview, sid?: string, eid?: string) {
  return {
    token: p.token,
    title: "Book",
    sourceId: sid,
    confirmed: true as const,
    choices: p.groups.map(
      (g) =>
        ({
          groupKey: g.key,
          action: eid ? "existing" : "new",
          expressionId: eid,
        }) as ImportChoice,
    ),
  };
}

test("source names normalize by type, ID retries are stable, explicit distinct source and rename remain available", () => {
  const f = setup();
  try {
    const a = source(f.s, " ＢＯＯＫ  ");
    assert.throws(
      () => source(f.s, " book", { author: "Different author" }),
      /同名/,
    );
    assert.equal(f.s.createSource(a).id, a.id);
    const b = source(f.s, "book", { allowSameName: true });
    assert.notEqual(a.id, b.id);
    source(f.s, "BOOK", { type: "Writing" });
    const c = source(f.s, "Other");
    assert.throws(
      () => f.s.updateSource(c.id, { ...c, title: "book" }, c.version),
      /同名/,
    );
    assert.equal(
      f.s.updateSource(
        c.id,
        { ...c, title: "book" },
        c.version,
        undefined,
        true,
      ).title,
      "book",
    );
  } finally {
    f.close();
  }
});

test("merge moves all source references, folds only exact same-sense events and preserves Review history and restorable backup", () => {
  const f = setup();
  try {
    const a = source(f.s),
      b = source(f.s, " book ", { allowSameName: true });
    const eid = save(f.s, a.id);
    save(f.s, b.id, undefined, eid);
    save(f.s, b.id, "A different sentence.", eid);
    const pending = f.s.createDraft(randomUUID(), {
      ...emptyDraft("Reading", b.id),
      term: "pending",
    });
    const ignored = f.s.createDraft(randomUUID(), {
      ...emptyDraft("Reading", b.id),
      term: "ignored",
    });
    f.s.updateDraft(ignored.id, ignored.data, 1, "ignored");
    history(f.s, eid);
    const prior = record(f.s),
      before = exportBackup(f.s);
    const p = previewSourceMerge(f.s, { fromId: b.id, toId: a.id });
    assert.equal(p.duplicateContexts, 1);
    assert.equal(p.drafts, 4);
    const r = commitSourceMerge(f.s, { token: p.token, confirmed: true });
    assert.equal(f.s.expression(eid).contextCount, 2);
    assert.equal(f.s.expression(eid).deletedContexts.length, 1);
    assert.equal(f.s.getSource(b.id).lifecycle, "archived");
    assert.equal(f.s.getDraft(pending.id).data.sourceId, a.id);
    assert.equal(f.s.getDraft(ignored.id).state, "ignored");
    assert.equal(record(f.s), prior);
    assert.equal(f.s.all("SELECT * FROM review_entries").length, 1);
    assert.equal(validateBackup(exportBackup(f.s)).contexts.length, 3);
    assert.equal(
      readSnapshot(f.s, r.snapshot).contexts.length,
      before.contexts.length,
    );
    assert.throws(
      () => commitSourceMerge(f.s, { token: p.token, confirmed: true }),
      /重新预览/,
    );
  } finally {
    f.close();
  }
});

test("same word with independent sense IDs or different notes is never silently folded", () => {
  const f = setup();
  try {
    const a = source(f.s),
      b = source(f.s, "Book", { allowSameName: true });
    save(f.s, a.id);
    save(f.s, b.id);
    const eid = f.s.search()[0].id;
    const d = f.s.createDraft(randomUUID(), {
      ...emptyDraft("Reading", b.id),
      term: "carve out",
      sentence: "We carve out time.",
      meaning: "腾出时间",
      priority: "P1",
      note: "personal note",
    });
    f.s.saveDraft(d.id, {
      version: 1,
      expressionId: eid,
      allowDuplicate: true,
    });
    const p = previewSourceMerge(f.s, { fromId: b.id, toId: a.id });
    assert.equal(p.duplicateContexts, 0);
    commitSourceMerge(f.s, { token: p.token, confirmed: true });
    assert.equal(f.s.search().length, 2);
    assert.equal(
      f.s.all("SELECT * FROM contexts WHERE lifecycle='active'").length,
      3,
    );
  } finally {
    f.close();
  }
});

test("merge rejects stale, tampered, wrong-kind and cross-type plans; late SQL failure rolls back all data", () => {
  const f = setup();
  try {
    const a = source(f.s),
      b = source(f.s, "Book", { allowSameName: true });
    save(f.s, b.id);
    const p = previewSourceMerge(f.s, { fromId: b.id, toId: a.id });
    assert.throws(() =>
      commitSourceMerge(f.s, { token: p.token + "bad", confirmed: true }),
    );
    f.s.createDraft(randomUUID(), {
      ...emptyDraft("Reading", b.id),
      term: "late",
    });
    assert.throws(
      () => commitSourceMerge(f.s, { token: p.token, confirmed: true }),
      /重新预览/,
    );
    const c = source(f.s, "Writing", { type: "Writing" });
    assert.throws(() => previewSourceMerge(f.s, { fromId: c.id, toId: a.id }));
    const q = previewSourceMerge(f.s, { fromId: b.id, toId: a.id });
    const before = materialState(f.s);
    f.s.db.exec(
      "CREATE TRIGGER fail_merge BEFORE UPDATE ON sources BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    assert.throws(() =>
      commitSourceMerge(f.s, { token: q.token, confirmed: true }),
    );
    assert.equal(materialState(f.s), before);
    assert.equal(f.s.getSource(b.id).lifecycle, "active");
  } finally {
    f.close();
  }
});

test("merge snapshot failure and maintenance refuse mutation", () => {
  const f = setup();
  try {
    const a = source(f.s),
      b = source(f.s, "Book", { allowSameName: true });
    save(f.s, b.id);
    const p = previewSourceMerge(f.s, { fromId: b.id, toId: a.id }),
      before = materialState(f.s);
    const blocked = join(f.dir, "blocked");
    writeFileSync(blocked, "x");
    Object.defineProperty(f.s, "snapshotDir", { value: blocked });
    assert.throws(() =>
      commitSourceMerge(f.s, { token: p.token, confirmed: true }),
    );
    assert.equal(materialState(f.s), before);
    f.s.db
      .prepare("INSERT INTO workspace_meta VALUES('maintenance','1')")
      .run();
    assert.throws(() =>
      commitSourceMerge(f.s, { token: p.token, confirmed: true }),
    );
  } finally {
    f.close();
  }
});

test("reordered and renamed workbook skips duplicates; missing rows remain; genuinely new contexts append to explicit sense", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book(), "a.xlsx", f.s),
      first = commitExcel(f.s, input(p));
    const eid = f.s.search()[0].id;
    const q = await previewExcel(
      await book([
        rows[1],
        rows[0],
        [
          "carve out",
          "phrase",
          "腾出",
          "new context",
          "A new sentence.",
          "P1",
          "理由",
          "target",
        ],
      ]),
      "renamed.xlsx",
      f.s,
    );
    const o = input(q, first.sourceId, eid),
      d = previewImportDiff(f.s, o);
    assert.equal(d.counts.duplicate, 2);
    assert.equal(d.counts.new, 1);
    const r = commitExcel(f.s, { ...o, diffToken: d.token });
    assert.equal(r.importedContexts, 1);
    assert.equal(f.s.search().length, 1);
    assert.equal(f.s.expression(eid).contextCount, 3);
    const missing = await previewExcel(
      await book([rows[0]]),
      "subset.xlsx",
      f.s,
    );
    commitExcel(f.s, input(missing, first.sourceId, eid));
    assert.equal(f.s.expression(eid).contextCount, 3);
  } finally {
    f.close();
  }
});

test("changed import defaults to keep, explicit update snapshots and preserves personal fields, sense priority and Review records", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book(), "a.xlsx", f.s),
      first = commitExcel(f.s, input(p)),
      e = f.s.search()[0];
    history(f.s, e.id);
    const c = f.s
      .expression(e.id)
      .contexts.find((x) => x.data.sentence === rows[0][4])!;
    f.s.updateContext(
      c.id,
      { ...c.data, note: "my note", priority: "P2" },
      c.version,
      e.id,
    );
    f.s.updateExpression(
      e.id,
      {
        ...f.s.expression(e.id),
        meaning: "my dictionary meaning",
        alternative: "my alternative",
      },
      f.s.expression(e.id).version,
    );
    const recordBefore = record(f.s);
    const changed = rows.map((r) => [...r]);
    changed[0][3] = "revised context";
    changed[0][4] = "A corrected original sentence.";
    const q = await previewExcel(await book(changed), "new.xlsx", f.s),
      o = input(q, first.sourceId, e.id),
      d = previewImportDiff(f.s, o);
    assert.equal(d.counts.changed, 1);
    assert.equal(d.counts.duplicate, 1);
    const keep = commitExcel(f.s, { ...o, diffToken: d.token });
    assert.equal(keep.updatedContexts, 0);
    assert.equal(f.s.context(c.id).data.sentence, rows[0][4]);
    const again = previewImportDiff(f.s, o),
      key = again.rows.find((r) => r.status === "changed")!.key;
    assert.throws(
      () => commitExcel(f.s, { ...o, updates: { [key]: "update" } }),
      /对比/,
    );
    const r = commitExcel(f.s, {
      ...o,
      diffToken: again.token,
      updates: { [key]: "update" },
    });
    assert.equal(r.updatedContexts, 1);
    assert.ok(r.snapshot);
    assert.equal(snapshots(f.s).length, 1);
    const updated = f.s.context(c.id);
    assert.equal(updated.data.sentence, changed[0][4]);
    assert.equal(updated.data.meaning, "revised context");
    assert.equal(updated.data.note, "my note");
    assert.equal(updated.data.priority, "P2");
    assert.equal(f.s.expression(e.id).meaning, "my dictionary meaning");
    assert.equal(f.s.expression(e.id).alternative, "my alternative");
    assert.equal(record(f.s), recordBefore);
    validateBackup(exportBackup(f.s));
    assert.equal(previewImportDiff(f.s, o).counts.duplicate, 2);
  } finally {
    f.close();
  }
});

test("ambiguous same-position imports and deleted contexts are protected; stale and changed-selection proofs fail closed", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book(), "a.xlsx", f.s),
      r = commitExcel(f.s, input(p)),
      e = f.s.search()[0];
    const q = await previewExcel(await book(), "a.xlsx", f.s),
      o = input(q, r.sourceId, e.id);
    const d = previewImportDiff(f.s, o);
    assert.throws(
      () => commitExcel(f.s, { ...o, title: "Other", diffToken: d.token }),
      /重新对比/,
    );
    const c = e.contexts[0];
    f.s.setContextDeleted(c.id, c.version, true);
    assert.throws(
      () => commitExcel(f.s, { ...o, diffToken: d.token }),
      /重新对比/,
    );
    const updated = previewImportDiff(f.s, o);
    assert.equal(updated.counts.protected, 1);
    commitExcel(f.s, { ...o, diffToken: updated.token });
    assert.equal(f.s.expression(e.id).contexts.length, 1);
    assert.throws(() =>
      commitSourceMerge(f.s, { token: updated.token, confirmed: true }),
    );
  } finally {
    f.close();
  }
});

test("late import update failure rolls back every row and snapshot failure leaves content unchanged", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book(), "a.xlsx", f.s),
      r = commitExcel(f.s, input(p)),
      eid = f.s.search()[0].id;
    const changed = rows.map((x) => [...x]);
    changed[0][3] = "update A";
    changed[1][3] = "update B";
    const q = await previewExcel(await book(changed), "b.xlsx", f.s),
      o = input(q, r.sourceId, eid),
      d = previewImportDiff(f.s, o),
      updates = Object.fromEntries(d.rows.map((x) => [x.key, "update"]));
    const before = materialState(f.s);
    f.s.db.exec(
      "CREATE TRIGGER fail_update BEFORE UPDATE ON contexts WHEN json_extract(NEW.data,'$.meaning')='update B' BEGIN SELECT RAISE(ABORT,'late'); END",
    );
    assert.throws(() =>
      commitExcel(f.s, { ...o, diffToken: d.token, updates }),
    );
    assert.equal(materialState(f.s), before);
    f.s.db.exec("DROP TRIGGER fail_update");
    const blocked = join(f.dir, "blocked");
    writeFileSync(blocked, "x");
    Object.defineProperty(f.s, "snapshotDir", { value: blocked });
    assert.throws(() =>
      commitExcel(f.s, { ...o, diffToken: d.token, updates }),
    );
    assert.equal(materialState(f.s), before);
  } finally {
    f.close();
  }
});

test("different sense from the same quote can be explicitly added without replacing the old sense; expiry and proof tampering rejected", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book([rows[0]]), "a.xlsx", f.s),
      r = commitExcel(f.s, input(p));
    const changed = [[...rows[0]]];
    changed[0][2] = "刻出";
    const q = await previewExcel(await book(changed), "b.xlsx", f.s),
      o = input(q, r.sourceId),
      d = previewImportDiff(f.s, o),
      key = d.rows[0].key;
    assert.equal(d.counts.changed, 1);
    const now = Date.now;
    try {
      Date.now = () => now() + 31 * 60_000;
      assert.throws(() =>
        commitExcel(f.s, {
          ...o,
          diffToken: d.token,
          updates: { [key]: "add" },
        }),
      );
    } finally {
      Date.now = now;
    }
    assert.throws(() =>
      commitExcel(f.s, {
        ...o,
        diffToken: d.token + "bad",
        updates: { [key]: "add" },
      }),
    );
    const result = commitExcel(f.s, {
      ...o,
      diffToken: d.token,
      updates: { [key]: "add" },
    });
    assert.equal(result.createdExpressions, 1);
    assert.equal(f.s.search().length, 2);
    assert.deepEqual(
      f.s
        .search()
        .map((e) => e.meaning)
        .sort(),
      ["刻出", "腾出"].sort(),
    );
    validateBackup(exportBackup(f.s));
  } finally {
    f.close();
  }
});

test("multiple incoming rows cannot overwrite one old context through ambiguous row matching", async () => {
  const f = setup();
  try {
    const p = await previewExcel(await book([rows[0]]), "a.xlsx", f.s),
      r = commitExcel(f.s, input(p));
    const incoming = [[...rows[0]], [...rows[0]]];
    incoming[0][3] = "first correction";
    incoming[1][3] = "second correction";
    const q = await previewExcel(await book(incoming), "b.xlsx", f.s),
      o = input(q, r.sourceId, f.s.search()[0].id),
      d = previewImportDiff(f.s, o);
    assert.equal(d.counts.ambiguous, 2);
    assert.throws(
      () =>
        commitExcel(f.s, {
          ...o,
          diffToken: d.token,
          updates: { [d.rows[0].key]: "update" },
        }),
      /只能处理/,
    );
    commitExcel(f.s, { ...o, diffToken: d.token });
    assert.equal(f.s.search()[0].contextCount, 1);
    assert.equal(f.s.search()[0].contexts[0].data.meaning, rows[0][3]);
  } finally {
    f.close();
  }
});

test("Listening source merge validates target duration instead of producing an invalid restore file", () => {
  const f = setup();
  try {
    const a = source(f.s, "Podcast", { type: "Listening", duration: 30 }),
      b = source(f.s, "Podcast", {
        type: "Listening",
        duration: 120,
        allowSameName: true,
      });
    const d = f.s.createDraft(randomUUID(), {
      ...emptyDraft("Listening", b.id),
      term: "listen up",
      sentence: "Listen up now.",
      meaning: "仔细听",
      timestamp: "01:00",
    });
    f.s.saveDraft(d.id, { version: 1 });
    const before = materialState(f.s);
    assert.throws(
      () => previewSourceMerge(f.s, { fromId: b.id, toId: a.id }),
      /时长/,
    );
    assert.equal(materialState(f.s), before);
    const current = f.s.getSource(a.id);
    f.s.updateSource(a.id, { ...current, duration: 120 }, current.version);
    const plan = previewSourceMerge(f.s, { fromId: b.id, toId: a.id });
    commitSourceMerge(f.s, { token: plan.token, confirmed: true });
    validateBackup(exportBackup(f.s));
  } finally {
    f.close();
  }
});
