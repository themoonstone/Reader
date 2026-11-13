import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store";
import { inspectExcel, sheetSelectionSchema } from "../lib/excel-sheets";
import {
  previewExcel,
  previewImportDiff,
  commitExcel,
} from "../lib/excel-import";
import { standardHeaders } from "../lib/standard-import";
import { standardRow } from "./fixtures/sheet-workbooks";
import { exportBackup, previewRestore, commitRestore } from "../lib/backup";
import { handle } from "../lib/http";
import { Review } from "../lib/review";
import type {
  ImportPriority,
  ImportPreview,
  ImportChoice,
} from "../lib/import-contracts";

const levels: ImportPriority[] = ["P1", "P2", "P3"];
async function fixture(
  profile: "standard" | "bebe" | "farm" = "standard",
  edit?: (w: ExcelJS.Workbook) => void,
) {
  const w = new ExcelJS.Workbook();
  for (const [i, priority] of ["P3", "P2", "P1"].entries()) {
    const sheet = w.addWorksheet(
      profile === "standard" ? `Chapter ${i + 1}` : "Chapter 1",
    );
    const term = "make room";
    if (profile === "standard") {
      const row = standardRow(term, sheet.name, "Level Test Book");
      row[9] = priority;
      sheet.addRows([standardHeaders, row]);
    } else {
      if (profile === "bebe") {
        sheet.addRow([
          "Circled item",
          "Type",
          "Dictionary / core Chinese meaning",
          "Meaning in this context (English)",
          "Sentence / context",
          "复习优先级（严格版）",
        ]);
        for (const [j, p] of levels.entries())
          sheet.addRow([
            `term${j}`,
            "word",
            "中文释义",
            "contextual meaning",
            `A term${j} appeared.`,
            p,
          ]);
      } else {
        sheet.getCell("A2").value = "Our Little Farm · Chapter 1";
        sheet.getRow(5).values = [
          "词汇 / 表达",
          "来源",
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
        for (const [j, p] of levels.entries())
          sheet.addRow([
            `term${j}`,
            "book·12",
            "/test/",
            "noun",
            "core meaning",
            "contextual meaning",
            "中文释义",
            `A term${j} appeared.`,
            p,
            "",
            "plain meaning",
          ]);
      }
      break;
    }
  }
  edit?.(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}
async function preview(
  db: Store,
  bytes: Buffer,
  priorities?: ImportPriority[],
) {
  const info = await inspectExcel(bytes, "levels.xlsx", db.generation);
  return previewExcel(bytes, "levels.xlsx", db, {
    mode: "selected-sheets-v1",
    inspectionToken: info.inspectionToken,
    selectedSheetIds: info.sheets
      .filter((s) => s.role === "data")
      .map((s) => s.sheetId),
    ...(priorities ? { priorities } : {}),
  });
}
function options(p: ImportPreview, sourceId?: string) {
  return {
    token: p.token,
    title: p.suggestedTitle,
    sourceId,
    confirmed: true,
    choices: p.groups.map<ImportChoice>((g) => {
      const match = g.candidates.filter(
        (c) => c.lifecycle === "active" && c.meaning === g.meaning,
      );
      return match.length === 1
        ? {
            groupKey: g.key,
            action: "existing" as const,
            expressionId: match[0].id,
          }
        : { groupKey: g.key, action: "new" as const };
    }),
  };
}
function commit(db: Store, p: ImportPreview, sourceId?: string) {
  const input = options(p, sourceId),
    diff = previewImportDiff(db, input);
  return { diff, result: commitExcel(db, { ...input, diffToken: diff.token }) };
}
function business(db: Store) {
  const state = exportBackup(db);
  state.exported_at = "";
  return state;
}

test("levels: default remains P1, combinations preserve each adapter's actual priorities", async () => {
  for (const profile of ["standard", "bebe", "farm"] as const) {
    const db = new Store(":memory:");
    try {
      const bytes = await fixture(profile),
        before = business(db),
        initial = await preview(db, bytes);
      assert.deepEqual(initial.selection?.priorities, ["P1"]);
      assert.equal(initial.excludedRows, 2);
      assert.equal(initial.groups.flatMap((g) => g.rows).length, 1);
      for (const priorities of [
        ["P2"],
        ["P3"],
        ["P1", "P3"],
        ["P3", "P1", "P2"],
      ] as ImportPriority[][]) {
        const p = await preview(db, bytes, priorities);
        assert.deepEqual(p.selection?.priorities, [...priorities].sort());
        assert.deepEqual(p.counts, { P1: 1, P2: 1, P3: 1 });
        assert.deepEqual(
          p.groups
            .flatMap((g) => g.rows)
            .map((r) => r.data.priority)
            .sort(),
          [...priorities].sort(),
        );
        assert.equal(p.excludedRows, 3 - priorities.length);
      }
      assert.deepEqual(business(db), before);
      const all = await preview(db, bytes, levels),
        done = commit(db, all);
      assert.equal(done.result.importedContexts, 3);
      assert.deepEqual(
        exportBackup(db)
          .contexts.map((c) => c.data.priority)
          .sort(),
        levels,
      );
    } finally {
      db.close();
    }
  }
});

test("levels: schema and API reject empty, duplicate, unknown or implicit grades without writes", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await fixture(),
      info = await inspectExcel(bytes, "levels.xlsx", db.generation);
    const selection = {
      mode: "selected-sheets-v1",
      inspectionToken: info.inspectionToken,
      selectedSheetIds: [info.sheets[0].sheetId],
    };
    const before = business(db);
    const request = (id: string, body: unknown) =>
      handle(
        new Request(`http://localhost:3000/api/imports/${id}`, {
          method: "POST",
          headers: {
            Origin: "http://localhost:3000",
            "Content-Type": "application/json",
            "X-ReadWords-Generation": db.generation,
          },
          body: JSON.stringify(body),
        }),
        ["imports", id],
        db,
      );
    const file = { fileName: "levels.xlsx", content: bytes.toString("base64") };
    for (const priorities of [
      [],
      ["P2", "P2"],
      ["P4"],
      "P2",
      ["P1", "P2", "P3", "P1"],
    ]) {
      assert.equal(
        sheetSelectionSchema.safeParse({ ...selection, priorities }).success,
        false,
      );
      assert.equal(
        (await request("preview", { ...file, ...selection, priorities }))
          .status,
        400,
      );
    }
    assert.equal(
      (await request("preview", { ...file, priorities: ["P2"] })).status,
      400,
    );
    assert.equal(
      (await request("inspect", { ...file, priorities: ["P2"] })).status,
      400,
    );
    const accepted = await request("preview", {
      ...file,
      ...selection,
      priorities: ["P3"],
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).groups[0].rows[0].data.priority, "P3");
    assert.deepEqual(business(db), before);
  } finally {
    db.close();
  }
});

test("levels: low-level content is still validated when not selected; empty selected result cannot create source", async () => {
  for (const profile of ["standard", "bebe", "farm"] as const) {
    const db = new Store(":memory:");
    try {
      const bytes = await fixture(profile, (w) => {
        if (profile === "standard")
          w.getWorksheet("Chapter 1")!.getCell("G2").value = "not in sentence";
        else if (profile === "bebe")
          w.getWorksheet("Chapter 1")!.getCell("D4").value = "";
        else w.getWorksheet("Chapter 1")!.getCell("F8").value = "";
      });
      await assert.rejects(preview(db, bytes, ["P1"]));
      assert.equal(db.sources().length, 0);
    } finally {
      db.close();
    }
  }
  const db = new Store(":memory:");
  try {
    const bytes = await fixture("standard", (w) =>
      w.worksheets.forEach((s) => (s.getCell("J2").value = "P3")),
    );
    const p = await preview(db, bytes, ["P2"]);
    assert.equal(p.groups.length, 0);
    assert.equal(p.excludedRows, 3);
    assert.throws(() => commit(db, p), /至少选择/);
    assert.equal(db.sources().length, 0);
  } finally {
    db.close();
  }
});

test("levels: selection and all incoming rows are signed, old diff cannot authorize a different grade range", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await fixture(),
      low = await preview(db, bytes, ["P2"]),
      all = await preview(db, bytes, levels);
    const lowInput = options(low),
      lowDiff = previewImportDiff(db, lowInput),
      before = business(db);
    assert.throws(
      () => commitExcel(db, { ...options(all), diffToken: lowDiff.token }),
      /变化|对比/,
    );
    const [encoded, signature] = all.token.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    payload.scope.priorities = ["P1"];
    const tampered =
      Buffer.from(JSON.stringify(payload)).toString("base64url") +
      "." +
      signature;
    assert.throws(
      () => previewImportDiff(db, { ...options(all), token: tampered }),
      /失效|预览/,
    );
    payload.rows[0].data.priority = "P1";
    assert.throws(() =>
      commitExcel(db, {
        ...options(all),
        token:
          Buffer.from(JSON.stringify(payload)).toString("base64url") +
          "." +
          signature,
        diffToken: lowDiff.token,
      }),
    );
    assert.deepEqual(business(db), before);
  } finally {
    db.close();
  }
});

test("levels: P1 then all only adds missing lower-priority contexts; repeat and restore preserve history", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await fixture(),
      first = commit(db, await preview(db, bytes));
    const expression = db.search()[0],
      original = db.context(expression.contexts[0].id);
    const review = new Review(db);
    review.add({
      operation_id: randomUUID(),
      expression_ids: [expression.id],
      expected_versions: { [expression.id]: 0 },
    });
    const reviewState = db.all("SELECT * FROM review_entries ORDER BY id");
    const all = commit(
      db,
      await preview(db, bytes, levels),
      first.result.sourceId,
    );
    assert.equal(all.diff.counts.duplicate, 1);
    assert.equal(all.result.importedContexts, 2);
    assert.equal(all.result.createdExpressions, 0);
    assert.deepEqual(db.context(original.id), original);
    assert.equal(db.expression(expression.id).priority, "P1");
    assert.deepEqual(
      db.all("SELECT * FROM review_entries ORDER BY id"),
      reviewState,
    );
    const repeat = commit(
      db,
      await preview(db, bytes, levels),
      first.result.sourceId,
    );
    assert.equal(repeat.result.importedContexts, 0);
    assert.equal(repeat.result.skippedContexts, 3);
    const backup = exportBackup(db),
      restored = new Store(":memory:");
    try {
      const rp = previewRestore(restored, backup);
      commitRestore(restored, rp.token, true);
      assert.deepEqual(exportBackup(restored).contexts, backup.contexts);
      assert.deepEqual(
        exportBackup(restored).review_entries,
        backup.review_entries,
      );
      assert.equal(
        commit(
          restored,
          await preview(restored, bytes, levels),
          first.result.sourceId,
        ).result.importedContexts,
        0,
      );
    } finally {
      restored.close();
    }
  } finally {
    db.close();
  }
});

test("levels: new grouped expressions use highest group priority independently of row order; split keeps row grade", async () => {
  for (const reverse of [false, true]) {
    const db = new Store(":memory:");
    try {
      const bytes = await fixture("standard", (w) => {
        if (reverse) {
          w.getWorksheet("Chapter 1")!.getCell("J2").value = "P1";
          w.getWorksheet("Chapter 3")!.getCell("J2").value = "P3";
        }
      });
      const p = await preview(db, bytes, levels);
      assert.equal(commit(db, p).result.createdExpressions, 1);
      assert.equal(db.search()[0].priority, "P1");
      assert.deepEqual(
        db
          .search()[0]
          .contexts.map((c) => c.data.priority)
          .sort(),
        levels,
      );
      assert.equal(exportBackup(db).review_entries.length, 0);
    } finally {
      db.close();
    }
  }
  const db = new Store(":memory:");
  try {
    const p = await preview(db, await fixture(), levels),
      o = options(p);
    o.choices = o.choices.map((c) => ({ ...c, action: "split" }));
    const d = previewImportDiff(db, o);
    assert.equal(
      commitExcel(db, { ...o, diffToken: d.token }).createdExpressions,
      3,
    );
    assert.deepEqual(
      db
        .search()
        .map((e) => e.priority)
        .sort(),
      levels,
    );
    assert.equal(exportBackup(db).review_entries.length, 0);
    const p3 = db.search().find((e) => e.priority === "P3")!;
    assert.throws(
      () =>
        new Review(db).add({
          operation_id: randomUUID(),
          expression_ids: [p3.id],
          expected_versions: { [p3.id]: 0 },
        }),
      /P1\/P2/,
    );
  } finally {
    db.close();
  }
});

test("levels: reusing an existing P3 expression preserves its personal grade; legacy path still rejects it", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await fixture(),
      first = commit(db, await preview(db, bytes, ["P3"]));
    const e = db.search()[0];
    db.updateExpression(
      e.id,
      { ...e, alternative: "personal alternative" },
      e.version,
    );
    const all = commit(
      db,
      await preview(db, bytes, levels),
      first.result.sourceId,
    );
    assert.equal(all.result.createdExpressions, 0);
    assert.equal(all.result.importedContexts, 2);
    assert.equal(db.expression(e.id).priority, "P3");
    assert.equal(db.expression(e.id).alternative, "personal alternative");
    const oldFile = await fixture("bebe", (w) => {
      const s = w.getWorksheet("Chapter 1")!;
      s.getCell("A2").value = "make room";
      s.getCell("C2").value = "腾出时间";
    });
    const legacy = await previewExcel(oldFile, "old.xlsx", db);
    const o = options(legacy);
    assert.throws(
      () =>
        commitExcel(db, {
          ...o,
          choices: [
            {
              groupKey: legacy.groups[0].key,
              action: "existing",
              expressionId: e.id,
            },
          ],
        }),
      /不是 P1/,
    );
  } finally {
    db.close();
  }
});

test("levels: failure in a later selected page rolls back source, expressions and all context grades", async () => {
  const db = new Store(":memory:");
  try {
    const p = await preview(db, await fixture(), levels),
      o = options(p),
      d = previewImportDiff(db, o),
      before = business(db);
    db.db.exec(
      "CREATE TRIGGER fail_second BEFORE INSERT ON contexts WHEN (SELECT COUNT(*) FROM contexts)>0 BEGIN SELECT RAISE(ABORT,'grade failure'); END;",
    );
    assert.throws(
      () => commitExcel(db, { ...o, diffToken: d.token }),
      /grade failure/,
    );
    assert.deepEqual(business(db), before);
  } finally {
    db.close();
  }
});

test("levels: adopting a source-grade revision requires a snapshot, preserves personal grade and otherwise keeps old context", async () => {
  const db = new Store(":memory:");
  try {
    const file = async (priority: ImportPriority) => {
      const w = new ExcelJS.Workbook();
      const row = standardRow("make room", "Chapter 1", "Level Test Book");
      row[9] = priority;
      w.addWorksheet("语料填写").addRows([standardHeaders, row]);
      return Buffer.from(await w.xlsx.writeBuffer());
    };
    const first = commit(db, await preview(db, await file("P2"), ["P2"]));
    const e = db.search()[0],
      original = e.contexts[0];
    db.updateContext(
      original.id,
      { ...original.data, note: "personal note" },
      original.version,
      e.id,
    );
    const p = await preview(db, await file("P1"), ["P1"]),
      o = options(p, first.result.sourceId);
    const diff = previewImportDiff(db, o);
    assert.equal(diff.counts.changed, 1);
    assert(
      diff.rows[0].fields.some(
        (f) => f.field === "priority" && f.before === "P2" && f.after === "P1",
      ),
    );
    assert.equal(
      commitExcel(db, { ...o, diffToken: diff.token }).updatedContexts,
      0,
    );
    assert.equal(db.context(original.id).data.priority, "P2");
    const next = previewImportDiff(db, o),
      priorDirectory = db.snapshotDir,
      before = business(db);
    Object.defineProperty(db, "snapshotDir", {
      value: "/dev/null/cannot-create",
      configurable: true,
    });
    assert.throws(() =>
      commitExcel(db, {
        ...o,
        diffToken: next.token,
        updates: { [next.rows[0].key]: "update" },
      }),
    );
    assert.deepEqual(business(db), before);
    Object.defineProperty(db, "snapshotDir", { value: priorDirectory });
    const updated = commitExcel(db, {
      ...o,
      diffToken: next.token,
      updates: { [next.rows[0].key]: "update" },
    });
    assert(updated.snapshot);
    assert.equal(updated.updatedContexts, 1);
    assert.equal(db.context(original.id).data.priority, "P1");
    assert.equal(db.context(original.id).data.note, "personal note");
    assert.equal(db.expression(e.id).priority, "P2");
    assert.equal(
      commit(
        db,
        await preview(db, await file("P1"), ["P1"]),
        first.result.sourceId,
      ).result.importedContexts,
      0,
    );
  } finally {
    db.close();
  }
});
