import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import ExcelJS from "exceljs";
import { Store } from "../lib/store";
import { previewExcel, commitExcel } from "../lib/excel-import";

// Synthetic in-memory parser fixtures, never written over a user's workbook.
async function fixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Chapter 1");
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
  sheet.addRow([
    "carve out",
    "phrase",
    "腾出",
    "set aside time",
    "I carve out time.",
    "P1",
    "值得主动使用",
    "carve out time",
  ]);
  sheet.addRow([
    "carve out",
    "phrase",
    "腾出",
    "make time",
    "We carve out a moment.",
    "P1",
    "复用",
    "carve out a moment",
  ]);
  sheet.addRow([
    "carve out",
    "phrase",
    "腾出",
    "identify",
    "They carve out space.",
    "P2",
    "认识即可",
    "原句识别",
  ]);
  sheet.addRow([
    "teepee",
    "word",
    "帐篷",
    "a tent",
    "A teepee.",
    "P3",
    "记录即可",
    "查懂即过",
  ]);
  workbook
    .addWorksheet("P1 去重复习")
    .addRow(["复习目标或搭配", "carve out time"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
const choices = (p: Awaited<ReturnType<typeof previewExcel>>) =>
  p.groups.map((g) => ({ groupKey: g.key, action: "new" as const }));
test("P1 preview is read only, excludes summaries/P2/P3 and preserves contextual English separately", async () => {
  const store = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "book.xlsx", store);
    assert.deepEqual(p.counts, { P1: 2, P2: 1, P3: 1 });
    assert.equal(p.groups.length, 1);
    assert.equal(p.groups[0].rows.length, 2);
    assert.deepEqual(p.skippedSheets, ["P1 去重复习"]);
    assert.equal(
      p.groups[0].rows[0].data.importMetadata?.priorityConflict,
      true,
    );
    assert.equal(store.sources().length, 0);
    assert.equal(store.search().length, 0);
    const result = commitExcel(store, {
      token: p.token,
      title: "Bringing Up Bébé",
      confirmed: true,
      choices: choices(p),
    });
    assert.equal(result.importedContexts, 2);
    assert.equal(result.createdExpressions, 1);
    const e = store.search()[0];
    assert.equal(e.meaning, "腾出");
    assert.equal(e.contexts[0].data.priority, "P1");
    assert.equal(e.used, 0);
    assert.equal(e.seen, 2);
    assert.equal(
      e.contexts.every((c) => c.data.meaning !== "腾出"),
      true,
    );
  } finally {
    store.close();
  }
});
test("repeat import and lost success response are idempotent across previews", async () => {
  const store = new Store(":memory:");
  try {
    const file = await fixture();
    const p = await previewExcel(file, "book.xlsx", store);
    const input = {
      token: p.token,
      title: "Bringing Up Bébé",
      confirmed: true,
      choices: choices(p),
    };
    const first = commitExcel(store, input);
    const replay = commitExcel(store, input);
    assert.equal(replay.importedContexts, 0);
    assert.equal(replay.skippedContexts, 2);
    const again = await previewExcel(file, "renamed.xlsx", store);
    const third = commitExcel(store, {
      ...input,
      sourceId: first.sourceId,
      token: again.token,
      choices: choices(again),
    });
    assert.equal(third.importedContexts, 0);
    assert.equal(store.search().length, 1);
    assert.equal(store.sources().length, 1);
  } finally {
    store.close();
  }
});
test("import rejects tampering, missing decisions and absent confirmation before any data writes", async () => {
  const store = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "book.xlsx", store);
    const input = {
      token: p.token,
      title: "Book",
      confirmed: true,
      choices: choices(p),
    };
    assert.throws(() => commitExcel(store, { ...input, token: "x" + p.token }));
    assert.throws(() => commitExcel(store, { ...input, choices: [] }));
    assert.throws(() => commitExcel(store, { ...input, confirmed: false }));
    assert.equal(store.sources().length, 0);
  } finally {
    store.close();
  }
});
test("whole import rolls back when a later context fails", async () => {
  const store = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "book.xlsx", store);
    store.db.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON contexts WHEN (SELECT COUNT(*) FROM contexts)>0 BEGIN SELECT RAISE(ABORT,'test'); END;",
    );
    assert.throws(() =>
      commitExcel(store, {
        token: p.token,
        title: "Book",
        confirmed: true,
        choices: choices(p),
      }),
    );
    assert.equal(store.sources().length, 0);
    assert.equal(store.search().length, 0);
    assert.equal(store.drafts().length, 0);
    assert.equal(store.all("SELECT * FROM contexts").length, 0);
  } finally {
    store.close();
  }
});
test("existing P2 is not silently upgraded and separate senses remain possible", async () => {
  const store = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "book.xlsx", store);
    const first = commitExcel(store, {
      token: p.token,
      title: "Book",
      confirmed: true,
      choices: choices(p),
    });
    const e = store.search()[0];
    store.db
      .prepare("UPDATE expressions SET priority='P2' WHERE id=?")
      .run(e.id);
    const input = {
      token: p.token,
      title: "Book",
      sourceId: first.sourceId,
      confirmed: true,
      choices: p.groups.map((g) => ({
        groupKey: g.key,
        action: "existing",
        expressionId: e.id,
      })),
    };
    assert.throws(() => commitExcel(store, input), /不是 P1/);
    assert.equal(store.expression(e.id).priority, "P2");
  } finally {
    store.close();
  }
});
test("invalid, oversized and unsupported files are rejected", async () => {
  const store = new Store(":memory:");
  try {
    await assert.rejects(() =>
      previewExcel(Buffer.from("invalid"), "book.xlsx", store),
    );
    await assert.rejects(() =>
      previewExcel(Buffer.alloc(5 * 1024 * 1024 + 1), "book.xlsx", store),
    );
    await assert.rejects(() =>
      previewExcel(Buffer.alloc(1), "book.xls", store),
    );
  } finally {
    store.close();
  }
});
const file = "resources/bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx";
test(
  "actual supplied workbook: 120 P1 contexts / 112 conservative senses; no P2/P3 imported",
  { skip: !existsSync(file) },
  async () => {
    const store = new Store(":memory:");
    try {
      const p = await previewExcel(
        readFileSync(file),
        file.split("/").pop()!,
        store,
      );
      assert.equal(p.totalRows, 1098);
      assert.deepEqual(p.counts, { P1: 120, P2: 514, P3: 464 });
      assert.equal(p.groups.length, 112);
      const result = commitExcel(store, {
        token: p.token,
        title: "Bringing Up Bébé",
        confirmed: true,
        choices: choices(p),
      });
      assert.equal(result.importedContexts, 120);
      assert.equal(result.createdExpressions, 112);
      assert.equal(store.search("", "", "P2").length, 0);
      assert.equal(store.search("", "", "P3").length, 0);
      assert.equal(store.all("SELECT * FROM contexts").length, 120);
    } finally {
      store.close();
    }
  },
);
