import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { inspectExcel, selectedSheets } from "../lib/excel-sheets";
import { loadExcelWorkbook } from "../lib/excel-workbook";
import { Store } from "../lib/store";
import { exportBackup } from "../lib/backup";
import { workbookFile, standardRow } from "./fixtures/sheet-workbooks";
import { standardHeaders } from "../lib/standard-import";

test("D1: inventory keeps order, roles, hidden pages and malformed candidates without business writes", async () => {
  const db = new Store(":memory:");
  try {
    const before = exportBackup(db);
    const bytes = await workbookFile((w) => {
      w.addWorksheet("Empty");
      w.addWorksheet("Hidden", { state: "veryHidden" }).addRows([
        standardHeaders,
        standardRow(),
      ]);
      w.addWorksheet("Bad").addRows([["英文词条"], ["term"]]);
      w.addWorksheet("Unknown").addRow(["some notes"]);
      w.addWorksheet("P1 去重复习").addRows([standardHeaders, standardRow()]);
    });
    const p = await inspectExcel(bytes, "multi.xlsx", db.generation);
    assert.deepEqual(
      p.sheets.map((s) => s.role),
      [
        "data",
        "data",
        "auxiliary",
        "empty",
        "data",
        "data",
        "unsupported",
        "auxiliary",
      ],
    );
    assert.equal(p.sheets[4].state, "veryHidden");
    assert.equal(p.sheets[0].estimatedRows, 1);
    assert.ok(p.sheets[5].headerIssues.some((s) => s.includes("中文语境释义")));
    const after = exportBackup(db);
    before.exported_at = after.exported_at;
    assert.deepEqual(after, before);
    const loaded = await loadExcelWorkbook(bytes, "multi.xlsx");
    const select = {
      mode: "selected-sheets-v1" as const,
      inspectionToken: p.inspectionToken,
      selectedSheetIds: [p.sheets[1].sheetId, p.sheets[0].sheetId],
    };
    assert.deepEqual(
      selectedSheets(loaded, bytes, select, db.generation).chosen.map(
        (s) => s.name,
      ),
      ["Chapter 8", "Chapter 9"],
    );
    for (const ids of [
      [],
      [p.sheets[0].sheetId, p.sheets[0].sheetId],
      [p.sheets[2].sheetId],
      ["a".repeat(64)],
    ])
      assert.throws(() =>
        selectedSheets(
          loaded,
          bytes,
          { ...select, selectedSheetIds: ids },
          db.generation,
        ),
      );
    assert.throws(() =>
      selectedSheets(loaded, bytes, select, "new generation"),
    );
    assert.throws(() =>
      selectedSheets(loaded, Buffer.from("changed"), select, db.generation),
    );
    assert.throws(() =>
      selectedSheets(
        loaded,
        bytes,
        { ...select, inspectionToken: p.inspectionToken + "x" },
        db.generation,
      ),
    );
  } finally {
    db.close();
  }
});
test("D1: global file restrictions cannot be bypassed by choosing a small sheet", async () => {
  await assert.rejects(inspectExcel(Buffer.from("bad"), "bad.xlsx", "g"));
  const bytes = await workbookFile((w) => {
    w.addWorksheet("Unselected giant").getCell("A10001").value = "large";
  });
  await assert.rejects(inspectExcel(bytes, "large.xlsx", "g"), /超出支持范围/);
  await assert.rejects(inspectExcel(await workbookFile(), "bad.xls", "g"));
  const w = new ExcelJS.Workbook();
  w.addWorksheet("P1 优先掌握").addRows([standardHeaders, standardRow()]);
  const p = await inspectExcel(
    Buffer.from(await w.xlsx.writeBuffer()),
    "summary.xlsx",
    "g",
  );
  assert.equal(p.sheets[0].role, "auxiliary");
});

import {
  previewExcel,
  commitExcel,
  previewImportDiff,
} from "../lib/excel-import";
import { validateBackup, previewRestore, commitRestore } from "../lib/backup";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Review } from "../lib/review";
import { handle } from "../lib/http";
import type { ImportChoice, ImportPreview } from "../lib/import-contracts";

async function selectedPreview(db: Store, bytes: Buffer, names?: string[]) {
  const info = await inspectExcel(bytes, "sheets.xlsx", db.generation);
  return previewExcel(bytes, "sheets.xlsx", db, {
    mode: "selected-sheets-v1",
    inspectionToken: info.inspectionToken,
    selectedSheetIds: info.sheets
      .filter((s) =>
        names
          ? names.includes(s.name)
          : s.role === "data" && s.state === "visible",
      )
      .map((s) => s.sheetId),
  });
}
function options(p: ImportPreview, sourceId?: string) {
  return {
    token: p.token,
    title: p.suggestedTitle,
    sourceId,
    confirmed: true as const,
    choices: p.groups.map<ImportChoice>((g) => {
      const matched = g.candidates.filter(
        (c) =>
          c.priority === "P1" &&
          c.lifecycle === "active" &&
          c.meaning === g.meaning,
      );
      return matched.length === 1
        ? {
            groupKey: g.key,
            action: "existing" as const,
            expressionId: matched[0].id,
          }
        : { groupKey: g.key, action: "new" as const };
    }),
  };
}
function commit(db: Store, p: ImportPreview, sourceId?: string) {
  const o = options(p, sourceId),
    diff = previewImportDiff(db, o);
  return { result: commitExcel(db, { ...o, diffToken: diff.token }), diff, o };
}
function business(db: Store) {
  const b = exportBackup(db);
  b.exported_at = "";
  return b;
}

test("D3: selected pages alone are validated; totals include P2/P3; legacy strict path is unchanged", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      w.getWorksheet("Chapter 9")!.getCell("G2").value = "absent";
      w.addWorksheet("Other book").addRows([
        standardHeaders,
        standardRow("other", "C1", "Another Book"),
      ]);
      w.addWorksheet("P2").addRows([
        standardHeaders,
        [
          ...standardRow("low").slice(0, 9),
          "P2",
          ...standardRow("low").slice(10),
        ],
      ]);
    });
    const p = await selectedPreview(db, bytes, ["Chapter 8", "P2"]);
    assert.deepEqual(p.counts, { P1: 1, P2: 1, P3: 0 });
    assert.equal(p.groups.length, 1);
    assert.equal(p.excludedRows, 1);
    assert.deepEqual(
      p.selection!.selectedSheets.map((s) => s.name),
      ["Chapter 8", "P2"],
    );
    await assert.rejects(
      selectedPreview(db, bytes, ["Chapter 8", "Chapter 9"]),
      /Chapter 9.*第 2 行.*高亮/,
    );
    await assert.rejects(
      selectedPreview(db, bytes, ["Chapter 8", "Other book"]),
      /书名不一致/,
    );
    await assert.rejects(previewExcel(bytes, "sheets.xlsx", db), /不是受支持/);
    const r = commit(db, p).result;
    assert.equal(r.importedContexts, 1);
    assert.equal(db.getSource(r.sourceId).readingStatus, "reading");
    const low = await selectedPreview(db, bytes, ["P2"]);
    assert.equal(low.groups.length, 0);
    assert.throws(() => commit(db, low), /至少选择/);
    assert.equal(db.sources().length, 1);
    const badLow = await workbookFile((w) => {
      const s = w.getWorksheet("Chapter 9")!;
      s.getCell("J2").value = "P2";
      s.getCell("G2").value = "absent";
    });
    await assert.rejects(selectedPreview(db, badLow, ["Chapter 9"]), /高亮/);
  } finally {
    db.close();
  }
});
test("D3: selected sheets reject formulas, missing headers, mixed formats and a different source book", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      w.getWorksheet("Chapter 9")!.getCell("K2").value = {
        formula: '"text"',
        result: "text",
      };
      w.addWorksheet("Broken").addRows([["英文词条"], ["a"]]);
      w.addWorksheet("Bebe").addRows([
        [
          "Circled item",
          "复习优先级（严格版）",
          "Type",
          "Dictionary / core Chinese meaning",
          "Meaning in this context (English)",
          "Sentence / context",
        ],
        ["a", "P1", "word", "词", "word", "A."],
      ]);
    });
    await assert.rejects(
      selectedPreview(db, bytes, ["Broken"]),
      /Broken.*表头/,
    );
    await assert.rejects(selectedPreview(db, bytes, ["Chapter 9"]), /公式/);
    await assert.rejects(
      selectedPreview(db, bytes, ["Chapter 8", "Bebe"]),
      /同一种模板/,
    );
    const p = await selectedPreview(db, bytes, ["Chapter 8"]);
    const source = db.createSource({
      id: randomUUID(),
      type: "Reading",
      title: "Wrong Book",
    });
    assert.throws(
      () => previewImportDiff(db, options(p, source.id)),
      /书名不一致/,
    );
    assert.throws(
      () => previewImportDiff(db, { ...options(p), title: "new wrong title" }),
      /书名不一致/,
    );
    const before = business(db);
    assert.throws(() => commitExcel(db, options(p)), /先对比/);
    assert.deepEqual(business(db), before);
  } finally {
    db.close();
  }
});
test("D4: identical pages collapse with provenance; conflicts and distinct senses never silently overwrite", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      w.getWorksheet("Chapter 9")!.getRow(2).values = standardRow();
    });
    const p = await selectedPreview(db, bytes);
    assert.equal(p.counts.P1, 2);
    assert.equal(p.groups[0].rows.length, 1);
    assert.equal(p.selection!.fileDuplicateCount, 1);
    assert.deepEqual(p.fileDuplicates, [
      {
        kept: { sheet: "Chapter 8", row: 2 },
        skipped: [{ sheet: "Chapter 9", row: 2 }],
      },
    ]);
    const r = commit(db, p).result;
    assert.equal(r.fileDuplicateContexts, 1);
    assert.equal(db.search()[0].seen, 1);
    const conflict = await workbookFile((w) => {
      const s = w.getWorksheet("Chapter 9")!;
      s.getRow(2).values = standardRow();
      s.getCell("O2").value = "different note";
    });
    await assert.rejects(selectedPreview(db, conflict), /内容冲突/);
    const senses = await workbookFile((w) => {
      const s = w.getWorksheet("Chapter 9")!;
      s.getRow(2).values = standardRow();
      s.getCell("B2").value = "另一个意思";
    });
    const q = await selectedPreview(db, senses);
    assert.equal(q.groups.length, 2);
    assert.equal(
      new Set(q.groups.flatMap((g) => g.rows.map((r) => r.key))).size,
      2,
    );
  } finally {
    db.close();
  }
});
test("D4: single-sheet then all sheets gives the same business content as all-at-once, repeat is zero new", async () => {
  const a = new Store(":memory:"),
    b = new Store(":memory:");
  try {
    const bytes = await workbookFile();
    const one = await selectedPreview(a, bytes, ["Chapter 8"]);
    const first = commit(a, one),
      id = first.result.sourceId;
    assert.throws(
      () => commitExcel(a, { ...first.o, diffToken: first.diff.token }),
      /变化/,
    );
    const all = await selectedPreview(a, bytes);
    assert.equal(commit(a, all, id).result.importedContexts, 1);
    const before = business(a),
      repeat = commit(a, await selectedPreview(a, bytes), id);
    assert.equal(repeat.result.importedContexts, 0);
    assert.equal(repeat.diff.counts.duplicate, 2);
    assert.deepEqual(business(a), before);
    commit(b, await selectedPreview(b, bytes));
    const content = (db: Store) =>
      db
        .search()
        .map((e) => [
          e.term,
          e.meaning,
          e.seen,
          e.used,
          e.contexts.map((c) => [c.data.sentence, c.data.chapter, c.data.page]),
        ])
        .sort();
    assert.deepEqual(content(a), content(b));
  } finally {
    a.close();
    b.close();
  }
});
test("D4: legacy standard records survive moving sheets, row reorder, rename and backup/restore without key rewrites", async () => {
  const db = new Store(":memory:");
  try {
    const w = new ExcelJS.Workbook();
    w.addWorksheet("语料填写").addRows([standardHeaders, standardRow()]);
    const old = await previewExcel(
      Buffer.from(await w.xlsx.writeBuffer()),
      "legacy.xlsx",
      db,
    );
    const first = commit(db, old).result;
    const before = business(db),
      original = db.search()[0];
    const moved = await workbookFile((w) => {
      w.removeWorksheet("Chapter 9");
      const s = w.getWorksheet("Chapter 8")!;
      s.name = "Renamed";
      s.spliceRows(2, 0, []);
    });
    const p = await selectedPreview(db, moved);
    assert.equal(commit(db, p, first.sourceId).diff.counts.duplicate, 1);
    assert.deepEqual(business(db), before);
    assert.equal(
      db.expression(original.id).contexts[0].data.importMetadata!.rowKey,
      original.contexts[0].data.importMetadata!.rowKey,
    );
    const restored = new Store(":memory:");
    try {
      const backup = validateBackup(exportBackup(db));
      commitRestore(restored, previewRestore(restored, backup).token, true);
      assert.equal(
        commit(restored, await selectedPreview(restored, moved), first.sourceId)
          .diff.counts.duplicate,
        1,
      );
    } finally {
      restored.close();
    }
  } finally {
    db.close();
  }
});
test("D5: file, selection and generation-bound proofs reject tampering; mutations make prior diffs stale", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile(),
      p = await selectedPreview(db, bytes, ["Chapter 8"]),
      q = await selectedPreview(db, bytes, ["Chapter 9"]);
    const o = options(p),
      diff = previewImportDiff(db, o),
      before = business(db);
    assert.throws(
      () => commitExcel(db, { ...options(q), diffToken: diff.token }),
      /变化/,
    );
    assert.throws(() =>
      commitExcel(db, { ...o, token: o.token + "x", diffToken: diff.token }),
    );
    assert.deepEqual(business(db), before);
    db.createSource({ id: randomUUID(), type: "Manual", title: "concurrent" });
    assert.throws(
      () => commitExcel(db, { ...o, diffToken: diff.token }),
      /变化/,
    );
    const inspected = await inspectExcel(bytes, "sheets.xlsx", db.generation);
    const loaded = await loadExcelWorkbook(bytes, "sheets.xlsx");
    const now = Date.now;
    try {
      Date.now = () => now() + 31 * 60_000;
      assert.throws(() => previewImportDiff(db, o), /有效|超过/);
      assert.throws(
        () =>
          selectedSheets(
            loaded,
            bytes,
            {
              mode: "selected-sheets-v1",
              inspectionToken: inspected.inspectionToken,
              selectedSheetIds: [inspected.sheets[0].sheetId],
            },
            db.generation,
          ),
        /失效/,
      );
    } finally {
      Date.now = now;
    }
    commitRestore(
      db,
      previewRestore(db, validateBackup(exportBackup(db))).token,
      true,
    );
    assert.throws(() => previewImportDiff(db, o), /学习库/);
  } finally {
    db.close();
  }
});
test("D5: second-page write failure rolls the entire batch back", async () => {
  const db = new Store(":memory:");
  try {
    const p = await selectedPreview(db, await workbookFile());
    const o = options(p),
      diff = previewImportDiff(db, o),
      before = business(db);
    db.db.exec(
      "CREATE TEMP TRIGGER fail_second BEFORE INSERT ON contexts WHEN (SELECT count(*) FROM contexts)>0 BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
    );
    assert.throws(
      () => commitExcel(db, { ...o, diffToken: diff.token }),
      /injected/,
    );
    assert.deepEqual(business(db), before);
    db.db.exec("DROP TRIGGER fail_second");
    assert.equal(
      commitExcel(db, { ...o, diffToken: diff.token }).importedContexts,
      2,
    );
  } finally {
    db.close();
  }
});
test("D3/D5: both real historical adapters support explicit selection and preserve full P1 counts", async (t) => {
  for (const [name, expected] of [
    ["bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx", 120],
    ["Our_Little_Farm_Vocabulary-4.xlsx", 50],
  ] as const) {
    const path = join(process.cwd(), "resources", name);
    if (!existsSync(path)) {
      t.skip(`Missing local-only ${name}`);
      return;
    }
    const db = new Store(":memory:");
    try {
      const p = await selectedPreview(db, readFileSync(path));
      assert.equal(p.counts.P1, expected);
      assert.equal(
        p.groups.reduce((n, g) => n + g.rows.length, 0),
        expected,
      );
      const r = commit(db, p).result;
      assert.equal(r.importedContexts, expected);
      assert.equal(
        commit(db, await selectedPreview(db, readFileSync(path)), r.sourceId)
          .result.importedContexts,
        0,
      );
    } finally {
      db.close();
    }
  }
});

test("D5: inspect/selected-preview API preserves read-only, origin and generation guards and rejects implicit selection", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile(),
      file = { fileName: "sheets.xlsx", content: bytes.toString("base64") };
    const request = (
      path: string,
      body: unknown,
      origin = "http://localhost:3000",
      generation = db.generation,
    ) =>
      handle(
        new Request(`http://localhost:3000/api/imports/${path}`, {
          method: "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            "X-ReadWords-Generation": generation,
          },
          body: JSON.stringify(body),
        }),
        ["imports", path],
        db,
      );
    const before = business(db),
      inspected = await request("inspect", file);
    assert.equal(inspected.status, 200);
    const info = await inspected.json();
    const selected = {
      ...file,
      mode: "selected-sheets-v1",
      inspectionToken: info.inspectionToken,
      selectedSheetIds: [info.sheets[0].sheetId],
    };
    assert.equal((await request("preview", selected)).status, 200);
    assert.equal(
      (await request("preview", { ...selected, mode: undefined })).status,
      400,
    );
    assert.equal(
      (await request("preview", { ...selected, mode: "unknown" })).status,
      400,
    );
    assert.equal(
      (await request("inspect", file, "https://evil.test")).status,
      403,
    );
    assert.equal(
      (await request("inspect", file, "http://localhost:3000", "old")).status,
      409,
    );
    assert.deepEqual(business(db), before);
    db.db
      .prepare(
        "INSERT INTO workspace_meta(key,value) VALUES('maintenance','1') ON CONFLICT(key) DO UPDATE SET value='1'",
      )
      .run();
    assert.equal((await request("inspect", file)).status, 503);
    assert.equal((await request("preview", selected)).status, 503);
  } finally {
    db.close();
  }
});

test("D3/D5: selected total limit counts all levels across pages before filtering", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      for (const name of ["Chapter 8", "Chapter 9"]) {
        const s = w.getWorksheet(name)!;
        for (let n = 0; n < 2500; n++)
          s.addRow([
            ...standardRow().slice(0, 9),
            "P2",
            ...standardRow().slice(10),
          ]);
      }
    });
    await assert.rejects(selectedPreview(db, bytes), /合计.*5,000/);
    assert.equal(db.sources().length, 0);
  } finally {
    db.close();
  }
});

test("D4/D5: selected revisions protect personal fields/Review, snapshot before updating and keep deleted data protected", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile(),
      first = commit(db, await selectedPreview(db, bytes)).result;
    const e = db.search().find((e) => e.term === "carve out")!,
      context = e.contexts[0];
    const review = new Review(db),
      tab = randomUUID();
    review.add({
      operation_id: randomUUID(),
      expression_ids: [e.id],
      expected_versions: { [e.id]: 0 },
    });
    let v = review.start({
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
    v = review.reveal(v.card!.id, {
      ...writer(),
      card_version: v.card!.version,
    });
    v = review.feedback(v.card!.id, {
      ...writer(),
      card_version: v.card!.version,
      result: "remember",
    });
    review.state(v.session!.id, { ...writer(), action: "end" });
    const records = db.all("SELECT * FROM review_records ORDER BY id");
    db.updateContext(
      context.id,
      { ...context.data, note: "my personal note" },
      context.version,
      e.id,
    );
    db.updateExpression(
      e.id,
      {
        ...e,
        meaning: "my personal dictionary meaning",
        alternative: "my alternative",
      },
      db.expression(e.id).version,
    );
    const revised = await workbookFile((w) => {
      w.getWorksheet("Chapter 8")!.getCell("F2").value =
        "Please carve out time.";
    });
    const p = await selectedPreview(db, revised),
      o = options(p, first.sourceId);
    o.choices = o.choices.map((c) =>
      c.groupKey === p.groups.find((g) => g.term === "carve out")!.key
        ? { groupKey: c.groupKey, action: "existing", expressionId: e.id }
        : c,
    );
    const diff = previewImportDiff(db, o);
    assert.equal(diff.counts.changed, 1);
    const keep = commitExcel(db, { ...o, diffToken: diff.token });
    assert.equal(keep.updatedContexts, 0);
    assert.equal(db.context(context.id).data.sentence, context.data.sentence);
    const next = previewImportDiff(db, o),
      key = next.rows.find((r) => r.status === "changed")!.key;
    const originalDir = db.snapshotDir;
    Object.defineProperty(db, "snapshotDir", {
      value: "/dev/null/cannot-create",
      configurable: true,
    });
    const before = business(db);
    assert.throws(() =>
      commitExcel(db, {
        ...o,
        diffToken: next.token,
        updates: { [key]: "update" },
      }),
    );
    assert.deepEqual(business(db), before);
    Object.defineProperty(db, "snapshotDir", { value: originalDir });
    const result = commitExcel(db, {
      ...o,
      diffToken: next.token,
      updates: { [key]: "update" },
    });
    assert.ok(result.snapshot);
    assert.equal(result.updatedContexts, 1);
    assert.equal(db.context(context.id).data.note, "my personal note");
    assert.equal(db.expression(e.id).meaning, "my personal dictionary meaning");
    assert.equal(db.expression(e.id).alternative, "my alternative");
    assert.deepEqual(
      db.all("SELECT * FROM review_records ORDER BY id"),
      records,
    );
    validateBackup(exportBackup(db));
    db.setContextDeleted(context.id, db.context(context.id).version, true);
    assert.equal(previewImportDiff(db, o).counts.protected, 1);
  } finally {
    db.close();
  }
});

test("D1/D5: previews and inspection proofs expire on signing-process restart", async () => {
  const db = new Store(":memory:");
  const state = globalThis as unknown as {
    readwordsImportSecret?: Buffer;
    readwordsChangeSecret?: Buffer;
  };
  const bytes = await workbookFile(),
    info = await inspectExcel(bytes, "file.xlsx", db.generation),
    p = await selectedPreview(db, bytes);
  const saved = {
    import: state.readwordsImportSecret,
    change: state.readwordsChangeSecret,
  };
  try {
    delete state.readwordsImportSecret;
    delete state.readwordsChangeSecret;
    const loaded = await loadExcelWorkbook(bytes, "file.xlsx");
    assert.throws(
      () =>
        selectedSheets(
          loaded,
          bytes,
          {
            mode: "selected-sheets-v1",
            inspectionToken: info.inspectionToken,
            selectedSheetIds: [info.sheets[0].sheetId],
          },
          db.generation,
        ),
      /失效/,
    );
    assert.throws(() => previewImportDiff(db, options(p)), /失效/);
  } finally {
    state.readwordsImportSecret = saved.import;
    state.readwordsChangeSecret = saved.change;
    db.close();
  }
});

test("D4: identical derived priority warnings across different page selections do not rewrite old contexts", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      w.getWorksheet("Chapter 9")!.getRow(2).values = [
        ...standardRow().slice(0, 9),
        "P2",
        ...standardRow().slice(10),
      ];
    });
    commit(db, await selectedPreview(db, bytes, ["Chapter 8"]));
    const before = business(db),
      all = await selectedPreview(db, bytes);
    assert.equal(
      all.groups[0].rows[0].data.importMetadata!.priorityConflict,
      true,
    );
    const replay = commit(db, all);
    assert.equal(replay.diff.counts.duplicate, 1);
    assert.deepEqual(business(db), before);
  } finally {
    db.close();
  }
});

test("D1: inspection response is bounded even for many extremely long unknown column names", async () => {
  const bytes = await workbookFile((w) => {
    const s = w.getWorksheet("Chapter 8")!;
    for (let n = 16; n < 76; n++)
      s.getRow(1).getCell(n).value = `${"long header ".repeat(1800)} ${n}`;
  });
  await assert.rejects(
    inspectExcel(bytes, "large-headers.xlsx", "g"),
    /清单超过 1 MB/,
  );
});
test("D4/D5: file duplicates, skipped groups and database duplicates are distinct counters", async () => {
  const db = new Store(":memory:");
  try {
    const bytes = await workbookFile((w) => {
      w.addWorksheet("Copy").addRows([standardHeaders, standardRow()]);
    });
    const p = await selectedPreview(db, bytes),
      o = options(p);
    o.choices = o.choices.map((c) =>
      p.groups.find((g) => g.key === c.groupKey)!.term === "make room"
        ? { groupKey: c.groupKey, action: "skip" as const }
        : c,
    );
    const diff = previewImportDiff(db, o),
      r = commitExcel(db, { ...o, diffToken: diff.token });
    assert.equal(p.counts.P1, 3);
    assert.equal(r.importedContexts, 1);
    assert.equal(r.fileDuplicateContexts, 1);
    assert.equal(r.skippedGroupContexts, 1);
    assert.equal(r.skippedContexts, 0);
  } finally {
    db.close();
  }
});
