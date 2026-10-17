import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store";
import { previewExcel, commitExcel } from "../lib/excel-import";
import { farmType } from "../lib/little-farm-import";
import { exportBackup, previewRestore, commitRestore } from "../lib/backup";
import type { ImportPreview } from "../lib/import-contracts";
const headers = [
  "词汇 / 表达",
  "来源·页码",
  "美音 IPA",
  "词性 / 类型",
  "核心英文释义",
  "本书语境义（英文）",
  "中文释义",
  "原文片段",
  "优先级",
  "学习理由",
  "简单英文释义 / 改写",
];
async function fixture(edit?: (w: ExcelJS.Workbook) => void) {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("Chapter 1");
  s.getCell("A2").value = "Our Little Farm · Chapter 1";
  s.getRow(5).values = headers;
  s.addRow([
    "take up",
    "标记·4,10",
    "/test/",
    "phrasal verb",
    "to occupy",
    "occupy room",
    "占用",
    "take up room",
    "P1",
    "日常常用",
    "occupy some space",
  ]);
  s.addRow([
    "rule of thumb",
    "补充·10",
    "/test/",
    "idiom",
    "a practical rule",
    "the approximate guide",
    "经验法则",
    "a rule of thumb",
    "P1",
    "值得输出",
    "a rough guide",
  ]);
  s.addRow([
    "lodge",
    "标记·10",
    "",
    "noun",
    "a small house",
    "their home",
    "小屋",
    "the lodge",
    "P2",
    "",
    "a small home",
  ]);
  s.addRow([
    "faunal",
    "标记·11",
    "",
    "adjective",
    "related to animals",
    "the visitors",
    "动物群的",
    "faunal guests",
    "P3",
    "",
    "animal-related",
  ]);
  const summary = w.addWorksheet("P1 优先掌握");
  summary.getCell("A2").value = "Our Little Farm · P1 优先掌握";
  summary.getRow(5).values = headers;
  summary.getRow(6).values = s.getRow(6).values;
  edit?.(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}
const input = (p: ImportPreview, sourceId?: string) => ({
  token: p.token,
  title: p.suggestedTitle,
  confirmed: true,
  sourceId,
  choices: p.groups.map((g) => ({ groupKey: g.key, action: "new" })),
});
test("farm row 5 adapter excludes summary, maps source/page and separates original excerpt from paraphrase", async () => {
  const s = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "renamed.xlsx", s);
    assert.equal(p.profile, "little-farm-v1");
    assert.equal(p.suggestedTitle, "Our Little Farm");
    assert.equal(p.totalRows, 4);
    assert.deepEqual(p.counts, { P1: 2, P2: 1, P3: 1 });
    assert.deepEqual(p.skippedSheets, ["P1 优先掌握"]);
    assert.equal(p.detailSheets, 1);
    assert.equal(s.sources().length, 0);
    const r = p.groups.find((g) => g.term === "take up")!.rows[0];
    assert.equal(r.row, 6);
    assert.equal(r.data.page, "4,10");
    assert.equal(r.data.importMetadata!.sourceMark, "标记");
    assert.equal(r.data.importMetadata!.rawSourceLocation, "标记·4,10");
    assert.equal(r.data.importMetadata!.simpleParaphrase, "occupy some space");
    assert.equal(r.data.sentence, "take up room");
    assert.equal(r.data.expressionType, "phrase");
    assert.equal(r.data.alternative, "");
    const result = commitExcel(s, input(p));
    assert.equal(result.importedContexts, 2);
    assert.equal(s.sources()[0].title, "Our Little Farm");
    assert.equal(s.sources()[0].readingStatus, "reading");
    const e = s.search("take up")[0];
    assert.equal(e.meaning, "占用");
    assert.equal(e.seen, 1);
    assert.equal(e.used, 0);
    assert.equal(e.contexts[0].data.meaning, "occupy room");
    assert.equal(e.contexts[0].data.sentence, "take up room");
    assert.equal(s.search("", "", "P2").length, 0);
    assert.equal(farmType("one", "noun / verb"), "word");
    assert.equal(farmType("a rule", "idiom"), "chunk");
    assert.equal(
      farmType("be likely to do", "adjective pattern"),
      "sentence_pattern",
    );
  } finally {
    s.close();
  }
});
test("farm repeat uploads and renamed files reuse row keys, profile keys never collide with bebe", async () => {
  const s = new Store(":memory:");
  try {
    const b = await fixture(),
      p = await previewExcel(b, "farm.xlsx", s);
    const result = commitExcel(s, input(p));
    const q = await previewExcel(b, "renamed.xlsx", s);
    assert.deepEqual(
      q.groups.map((g) => g.rows[0].key),
      p.groups.map((g) => g.rows[0].key),
    );
    const replay = commitExcel(s, input(q, result.sourceId));
    assert.equal(replay.importedContexts, 0);
    assert.equal(replay.skippedContexts, 2);
    assert.equal(s.sources().length, 1);
    assert.equal(s.search().length, 2);
    const old = new ExcelJS.Workbook(),
      sheet = old.addWorksheet("Chapter 1");
    sheet.addRow([
      "Circled item",
      "Type",
      "Dictionary / core Chinese meaning",
      "Meaning in this context (English)",
      "Sentence / context",
      "复习优先级（严格版）",
    ]);
    sheet.getRow(6).values = [
      "take up",
      "phrase",
      "占用",
      "occupy room",
      "take up room",
      "P1",
    ];
    const bebe = await previewExcel(
      Buffer.from(await old.xlsx.writeBuffer()),
      "old.xlsx",
      s,
    );
    assert.equal(bebe.profile, "bebe-strict-v1");
    assert.notEqual(bebe.groups[0].rows[0].key, p.groups[0].rows[0].key);
  } finally {
    s.close();
  }
});
test("farm rejects missing columns, formulas, invalid priority, mixed templates and summary-only input without writes", async () => {
  const s = new Store(":memory:");
  try {
    for (const change of [
      (w: ExcelJS.Workbook) => {
        w.worksheets[0].getCell("F5").value = "wrong";
      },
      (w: ExcelJS.Workbook) => {
        w.worksheets[0].getCell("H6").value = {
          formula: '"guessed"',
          result: "guessed",
        };
      },
      (w: ExcelJS.Workbook) => {
        w.worksheets[0].getCell("I6").value = "P0";
      },
      (w: ExcelJS.Workbook) => {
        w.worksheets[0].getCell("G6").value = "";
      },
      (w: ExcelJS.Workbook) => {
        w.worksheets[0].getCell("L5").value = "中文释义";
      },
      (w: ExcelJS.Workbook) => {
        w.removeWorksheet(w.worksheets[0].id);
      },
      (w: ExcelJS.Workbook) => {
        w.addWorksheet("Bebe").addRow(["Circled item", "复习优先级（严格版）"]);
      },
    ])
      await assert.rejects(() =>
        fixture(change).then((b) => previewExcel(b, "bad.xlsx", s)),
      );
    assert.equal(s.sources().length, 0);
    assert.equal(s.all("SELECT * FROM drafts").length, 0);
  } finally {
    s.close();
  }
});
test("farm replay cannot silently upgrade P2; late write failure rolls back the whole import", async () => {
  const s = new Store(":memory:");
  try {
    const p = await previewExcel(await fixture(), "farm.xlsx", s);
    s.db.exec(
      "CREATE TRIGGER fail_later BEFORE INSERT ON contexts WHEN (SELECT COUNT(*) FROM contexts)>0 BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => commitExcel(s, input(p)));
    assert.equal(s.sources().length, 0);
    assert.equal(s.all("SELECT * FROM contexts").length, 0);
    assert.equal(s.all("SELECT * FROM expressions").length, 0);
    assert.equal(s.all("SELECT * FROM drafts").length, 0);
    s.db.exec("DROP TRIGGER fail_later");
    const r = commitExcel(s, input(p));
    const e = s.search("take up")[0];
    s.updateExpression(e.id, { ...e, priority: "P2" }, e.version);
    const q = await previewExcel(await fixture(), "farm.xlsx", s);
    const request = input(q, r.sourceId);
    request.choices = request.choices.map((c) => ({
      ...c,
      action: "existing",
      expressionId: s.search(
        q.groups.find((g) => g.key === c.groupKey)!.term,
      )[0].id,
    }));
    assert.throws(() => commitExcel(s, request), /不是 P1/);
    assert.equal(s.expression(e.id).priority, "P2");
  } finally {
    s.close();
  }
});
test("farm preface missing pages stay empty; unknown location text is preserved without inventing numbers", async () => {
  const s = new Store(":memory:");
  try {
    const p = await previewExcel(
      await fixture((w) => {
        const sheet = w.worksheets[0];
        sheet.name = "Preface";
        sheet.getCell("A2").value = "Our Little Farm · Preface";
        sheet.getCell("B5").value = "来源";
        sheet.getCell("B6").value = "标记";
        sheet.getCell("B7").value = "补充·未标页码";
      }),
      "preface.xlsx",
      s,
    );
    for (const g of p.groups) {
      assert.equal(g.rows[0].data.page, "");
      assert(g.rows[0].warnings.includes("无页码"));
    }
    assert.equal(
      p.groups[1].rows[0].data.importMetadata!.rawSourceLocation,
      "补充·未标页码",
    );
  } finally {
    s.close();
  }
});
const farmFile = "resources/Our_Little_Farm_Vocabulary-4.xlsx",
  bebeFile = "resources/bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx";
test(
  "real Our Little Farm: 373 detail rows, exactly 50 P1 expressions and contexts, originals and backup roundtrip preserved",
  { skip: !existsSync(farmFile) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-farm-")),
      s = new Store(join(dir, "test.sqlite"));
    try {
      const p = await previewExcel(
        readFileSync(farmFile),
        "Our_Little_Farm_Vocabulary-4.xlsx",
        s,
      );
      assert.equal(p.totalRows, 373);
      assert.deepEqual(p.counts, { P1: 50, P2: 192, P3: 131 });
      assert.equal(p.detailSheets, 6);
      assert.deepEqual(p.skippedSheets, ["P1 优先掌握"]);
      assert.equal(p.groups.length, 50);
      const r = commitExcel(s, input(p));
      assert.equal(r.createdExpressions, 50);
      assert.equal(r.importedContexts, 50);
      assert.equal(
        s.search().reduce((n, e) => n + e.seen, 0),
        50,
      );
      assert(s.search().every((e) => e.priority === "P1" && e.used === 0));
      for (const group of p.groups) {
        const c = s.search(group.term).find((e) => e.term === group.term)!
          .contexts[0];
        assert.equal(c.data.sentence, group.rows[0].data.sentence);
        assert.deepEqual(
          c.data.importMetadata,
          group.rows[0].data.importMetadata,
        );
      }
      const backup = exportBackup(s),
        pre = previewRestore(s, backup);
      commitRestore(s, pre.token, true);
      assert.deepEqual(
        { ...exportBackup(s), exported_at: "" },
        { ...backup, exported_at: "" },
      );
      const again = await previewExcel(
        readFileSync(farmFile),
        "renamed.xlsx",
        s,
      );
      assert.equal(
        commitExcel(s, input(again, r.sourceId)).importedContexts,
        0,
      );
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "both real books coexist without changing earlier bebe records",
  { skip: !existsSync(farmFile) || !existsSync(bebeFile) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-both-books-")),
      s = new Store(join(dir, "test.sqlite"));
    try {
      const bebe = await previewExcel(readFileSync(bebeFile), "bebe.xlsx", s);
      assert.equal(bebe.groups.length, 112);
      commitExcel(s, input(bebe));
      const before = exportBackup(s);
      const farm = await previewExcel(readFileSync(farmFile), "farm.xlsx", s);
      commitExcel(s, input(farm));
      const after = exportBackup(s);
      assert.equal(s.search().length, 162);
      assert.equal(after.contexts.length, 170);
      assert.equal(after.sources.length, 2);
      for (const table of [
        "sources",
        "expressions",
        "contexts",
        "drafts",
      ] as const) {
        const ids = new Set(before[table].map((r) => r.id));
        assert.deepEqual(
          after[table].filter((r) => ids.has(r.id)),
          before[table],
        );
      }
      // An old bebe-only backup and a new mixed backup both restore losslessly.
      for (const backup of [before, after]) {
        const preview = previewRestore(s, backup);
        commitRestore(s, preview.token, true);
        assert.deepEqual(
          { ...exportBackup(s), exported_at: "" },
          { ...backup, exported_at: "" },
        );
      }
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
