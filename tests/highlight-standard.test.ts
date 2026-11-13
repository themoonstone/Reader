import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { readFileSync, existsSync } from "node:fs";
import { highlightParts } from "../lib/highlight";
import { standardHeaders } from "../lib/standard-import";
import {
  previewExcel,
  commitExcel,
  previewImportDiff,
} from "../lib/excel-import";
import { Store } from "../lib/store";
import { exportBackup, validateBackup } from "../lib/backup";
const row = [
  "carve out",
  "腾出时间",
  "Test Book",
  "Chapter 1",
  "12",
  "I carved out time.",
  "carved out",
  1,
  "已核对完整句",
  "P1",
  "Please carve out time.",
  "请腾出时间。",
  "自编",
  "carve out time",
  "",
];
async function file(edit?: (w: ExcelJS.Workbook) => void) {
  const w = new ExcelJS.Workbook();
  w.addWorksheet("语料填写").addRows([standardHeaders, row]);
  w.addWorksheet("填写说明").addRow(["说明"]);
  w.addWorksheet("填写示例").addRow(["示例不导入"]);
  edit?.(w);
  return Buffer.from(await w.xlsx.writeBuffer());
}
const choices = (p: Awaited<ReturnType<typeof previewExcel>>) =>
  p.groups.map((g) => ({ groupKey: g.key, action: "new" as const }));
test("literal highlight respects words, punctuation, Unicode, explicit forms/occurrences and preserves hostile text", () => {
  for (const [text, target, expected] of [
    ["A cat and cats; CAT.", "cat", ["cat", "CAT"]],
    [
      "Do it for the joy of it, today.",
      "for the joy of it",
      ["for the joy of it"],
    ],
    ["a.b is a.b", "a.b", ["a.b", "a.b"]],
    ["雪cat caté cat", "cat", ["cat"]],
  ] as const) {
    const p = highlightParts(text, target);
    assert.deepEqual(
      p.filter((x) => x.highlight).map((x) => x.text),
      expected,
    );
    assert.equal(p.map((x) => x.text).join(""), text);
  }
  assert.deepEqual(
    highlightParts("She had it in for him.", "had it in for him", 1, true)
      .filter((x) => x.highlight)
      .map((x) => x.text),
    ["had it in for him"],
  );
  assert.equal(
    highlightParts("Cat cat cat", "cat", 2, true).filter((x) => x.highlight)
      .length,
    1,
  );
  assert.equal(
    highlightParts("Cat cat", "cat", 2, true).filter((x) => x.highlight).length,
    0,
  );
  const unsafe = "<img src=x onerror=alert(1)> cat";
  assert.equal(
    highlightParts(unsafe, "cat")
      .map((x) => x.text)
      .join(""),
    unsafe,
  );
  assert.equal(
    highlightParts("We carved out time.", "carve out").some((x) => x.highlight),
    false,
  );
});
test("standard template filters only P1; retains Chinese, exact target and examples; replay and backup roundtrip are safe", async () => {
  const s = new Store(":memory:");
  try {
    const p = await previewExcel(
      await file((w) => {
        w.getWorksheet("语料填写")!.addRow([
          ...row.slice(0, 9),
          "P2",
          ...row.slice(10),
        ]);
      }),
      "standard.xlsx",
      s,
    );
    assert.deepEqual(p.counts, { P1: 1, P2: 1, P3: 0 });
    assert.equal(p.suggestedTitle, "Test Book");
    assert.equal(s.sources().length, 0);
    const options = {
      token: p.token,
      title: p.suggestedTitle,
      confirmed: true,
      choices: choices(p),
    };
    const r = commitExcel(s, options);
    assert.equal(r.importedContexts, 1);
    const e = s.search()[0],
      c = e.contexts[0];
    assert.equal(e.meaning, "腾出时间");
    assert.equal(c.data.meaning, "腾出时间");
    assert.equal(c.data.targetSurface, "carved out");
    assert.equal(c.data.importMetadata?.exampleSource, "自编");
    assert.equal(c.data.importMetadata?.contextMeaningEnglish, "");
    assert.equal(
      commitExcel(s, { ...options, sourceId: r.sourceId }).importedContexts,
      0,
    );
    validateBackup(exportBackup(s));
  } finally {
    s.close();
  }
});
test("standard template malformed fields, headers, formulas, mixed or unexpected sheets reject without any writes", async () => {
  const mutations: ((w: ExcelJS.Workbook) => void)[] = [
    (w) => {
      w.getWorksheet("语料填写")!.getCell("A1").value = "词条";
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("B1").value = "英文词条";
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("P1").value = "未知";
    },
    ...["B2", "C2", "I2", "J2"].map((addr) => (w: ExcelJS.Workbook) => {
      w.getWorksheet("语料填写")!.getCell(addr).value = "";
    }),
    (w) => {
      w.getWorksheet("语料填写")!.getCell("G2").value = "carve out";
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("H2").value = 2;
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("I2").value = "完整";
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("B2").value = {
        formula: '"释义"',
        result: "释义",
      };
    },
    (w) => {
      w.addWorksheet("Chapter 1").addRow([
        "Circled item",
        "复习优先级（严格版）",
      ]);
    },
    (w) => {
      w.addWorksheet("未识别数据").addRow(["其他数据"]);
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("M2").value = "";
    },
    (w) => {
      w.getWorksheet("语料填写")!.getCell("D2").value = "";
      w.getWorksheet("语料填写")!.getCell("E2").value = "";
    },
    (w) => {
      const r = [...row];
      r[2] = "Other Book";
      w.getWorksheet("语料填写")!.addRow(r);
    },
  ];
  for (const mutate of mutations) {
    const s = new Store(":memory:");
    try {
      await assert.rejects(previewExcel(await file(mutate), "bad.xlsx", s));
      assert.equal(s.sources().length, 0);
      assert.equal(s.drafts().length, 0);
    } finally {
      s.close();
    }
  }
});
test("blank generated template rejects; reordered headers and pending missing originals are handled explicitly", async () => {
  const s = new Store(":memory:");
  try {
    await assert.rejects(
      previewExcel(
        await file((w) => {
          w.getWorksheet("语料填写")!.getRow(2).values = [];
        }),
        "blank.xlsx",
        s,
      ),
      /没有可导入/,
    );
    const p = await previewExcel(
      await file((w) => {
        const sh = w.getWorksheet("语料填写")!;
        sh.getRow(1).values = [...standardHeaders].reverse();
        sh.getRow(2).values = [...row].reverse();
      }),
      "ordered.xlsx",
      s,
    );
    assert.equal(p.groups[0].term, "carve out");
    const missing = await previewExcel(
      await file((w) => {
        const sh = w.getWorksheet("语料填写")!;
        sh.getCell("F2").value = "";
        sh.getCell("G2").value = "";
        sh.getCell("H2").value = "";
        sh.getCell("I2").value = "待补充";
        sh.getCell("O2").value = "待查原书";
      }),
      "missing.xlsx",
      s,
    );
    assert.ok(missing.groups[0].rows[0].warnings.length);
  } finally {
    s.close();
  }
});
test("standard reimport diff updates highlight occurrence and preserves personal note and dictionary sense", async () => {
  const s = new Store(":memory:");
  try {
    const p = await previewExcel(await file(), "one.xlsx", s);
    const r = commitExcel(s, {
      token: p.token,
      title: p.suggestedTitle,
      confirmed: true,
      choices: choices(p),
    });
    const e = s.search()[0],
      c = e.contexts[0];
    s.updateContext(c.id, { ...c.data, note: "personal" }, c.version, e.id);
    const next = await previewExcel(
      await file((w) => {
        const sh = w.getWorksheet("语料填写")!;
        sh.getCell("F2").value = "I carved out time, then carved out more.";
        sh.getCell("H2").value = 2;
      }),
      "two.xlsx",
      s,
    );
    const options = {
      token: next.token,
      title: next.suggestedTitle,
      sourceId: r.sourceId,
      confirmed: true,
      choices: next.groups.map((g) => ({
        groupKey: g.key,
        action: "existing" as const,
        expressionId: e.id,
      })),
    };
    const diff = previewImportDiff(s, options);
    assert.equal(diff.counts.changed, 1);
    commitExcel(s, {
      ...options,
      diffToken: diff.token,
      updates: { [next.groups[0].rows[0].key]: "update" },
    });
    const after = s.expression(e.id);
    assert.equal(after.meaning, e.meaning);
    assert.equal(after.contexts[0].data.note, "personal");
    assert.equal(after.contexts[0].data.importMetadata?.highlightOccurrence, 2);
    validateBackup(exportBackup(s));
  } finally {
    s.close();
  }
});

test("actual generated template uses prefixed OOXML; compatible reading reaches empty-data validation", async (t) => {
  const path = "outputs/phrasebud-template-v1/PhraseBud_语料整理模板_v1.xlsx";
  if (!existsSync(path)) {
    t.skip("Local-only generated template absent");
    return;
  }
  const s = new Store(":memory:");
  try {
    await assert.rejects(
      previewExcel(readFileSync(path), "template.xlsx", s),
      /没有可导入/,
    );
  } finally {
    s.close();
  }
});

test("partial legacy chapter cannot be silently skipped beside a valid chapter", async () => {
  const w = new ExcelJS.Workbook();
  w.addWorksheet("Chapter 1").addRow(["Circled item", "复习优先级（严格版）"]);
  w.addWorksheet("Chapter 2").addRow(["Circled item", "Type"]);
  const s = new Store(":memory:");
  try {
    await assert.rejects(
      previewExcel(Buffer.from(await w.xlsx.writeBuffer()), "partial.xlsx", s),
      /Chapter 2 缺少列/,
    );
    assert.equal(s.sources().length, 0);
  } finally {
    s.close();
  }
});
