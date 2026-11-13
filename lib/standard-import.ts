import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { AppError } from "./store";
import { draftSchema, normalize } from "./contracts";
import type { ImportRow } from "./import-contracts";
import { highlightParts } from "./highlight";
export const standardHeaders = [
  "英文词条",
  "中文语境释义",
  "书名",
  "章节",
  "页码或位置",
  "书中原句或片段",
  "原句实际词形",
  "高亮出现序号",
  "原文状态",
  "优先级",
  "补充例句",
  "例句中文",
  "例句来源",
  "常用搭配",
  "核对备注",
];
const standardPages = new Set(["语料填写", "填写说明", "填写示例"]);
export function validateWorkbookFormat(workbook: ExcelJS.Workbook) {
  const markers = workbook.worksheets.map((s) => ({
    s,
    first: s.getRow(1).values as unknown[],
    farm: s.getCell("A2").text.startsWith("Our Little Farm ·"),
  }));
  const standard = markers.some(
    ({ s, first }) => s.name === "语料填写" || first.includes("英文词条"),
  );
  const farm = markers.some((m) => m.farm);
  const bebe = markers.some(({ first }) => first.includes("Circled item"));
  if ([standard, farm, bebe].filter(Boolean).length > 1)
    throw new AppError("一次导入只接受一种表格模板，请分开上传");
  if (!standard && !farm && !bebe)
    throw new AppError(
      "Excel 格式不符合要求：支持 PhraseBud v1 标准模板（语料填写页）、Bringing Up Bébé 严格分级表或 Our Little Farm 章节表。请使用标准模板，保留原列名后重新上传。",
    );
  for (const { s, first } of markers) {
    if (s.rowCount > 10000 || s.columnCount > 100)
      throw new AppError(`${s.name}：工作表超出支持范围`);
    if (
      bebe &&
      !farm &&
      !standard &&
      first.includes("Circled item") &&
      !["P1 优先掌握", "P1 去重复习", "优先级说明与统计"].includes(s.name) &&
      !first.includes("复习优先级（严格版）")
    )
      throw new AppError(
        `${s.name} 缺少列：复习优先级（严格版），已拦截整份文件`,
      );
    const hasValues =
      s.getRows(1, Math.min(s.rowCount, 10001))?.some((r) => r.hasValues) ??
      false;
    if (!hasValues) continue;
    const allowed = standard
      ? standardPages.has(s.name)
      : farm
        ? /^(Preface|Chapter\s+[1-9]\d*|P1 优先掌握)$/i.test(s.name)
        : first.includes("Circled item") ||
          ["P1 优先掌握", "P1 去重复习", "优先级说明与统计"].includes(s.name);
    if (!allowed)
      throw new AppError(
        `${s.name}：不是受支持的数据页或汇总页，请移除该页或单独上传，避免遗漏数据`,
      );
  }
  return standard;
}
export function parseStandard(
  workbook: ExcelJS.Workbook,
  fileName: string,
  sheetName = "语料填写",
  selected = false,
  priorities: readonly string[] = ["P1"],
) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new AppError("缺少“语料填写”工作表，请保留标准模板页名");
  if (sheet.rowCount > 10000 || sheet.columnCount > 100)
    throw new AppError(`${sheet.name}：工作表超出支持范围`);
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    if (cell.type === ExcelJS.ValueType.Formula)
      throw new AppError(`${sheet.name}：表头不能含公式，请保留纯文本列名`);
    const name = cell.text.trim();
    if (!name) return;
    if (headers.has(name))
      throw new AppError(`${sheet.name}：表头重复“${name}”，请仅保留一列`);
    if (!standardHeaders.includes(name))
      throw new AppError(
        `${sheet.name}：未知列“${name}”，请使用标准模板的原列名`,
      );
    headers.set(name, column);
  });
  const missing = standardHeaders.filter((h) => !headers.has(h));
  if (missing.length)
    throw new AppError(
      `${sheet.name}：缺少列 ${missing.join("、")}，请补回列名；可选字段也应保留空列`,
    );
  const rows: ImportRow[] = [],
    all: { term: string; priority: string }[] = [],
    counts: Record<string, number> = { P1: 0, P2: 0, P3: 0 };
  let title = "";
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    if (
      !row.values ||
      !Array.from({ length: sheet.columnCount }, (_, i) =>
        row.getCell(i + 1).text.trim(),
      ).some(Boolean)
    )
      continue;
    const fail = (name: string, why: string): never => {
      throw new AppError(`${sheet.name} 第 ${n} 行「${name}」：${why}`);
    };
    const value = (name: string) => {
      const cell = row.getCell(headers.get(name)!);
      if (
        cell.type === ExcelJS.ValueType.Formula ||
        (typeof cell.value === "object" &&
          cell.value &&
          !("richText" in cell.value))
      )
        fail(name, "仅接受纯文本或数值，请移除公式、链接及其他特殊对象");
      return cell.text.trim();
    };
    for (let column = 1; column <= sheet.columnCount; column++) {
      if (
        ![...headers.values()].includes(column) &&
        row.getCell(column).text.trim()
      )
        fail("表头", `第 ${column} 列有数据但没有受支持的列名`);
    }
    const values = Object.fromEntries(
      standardHeaders.map((h) => [h, value(h)]),
    );
    const [
      term,
      meaning,
      book,
      chapter,
      page,
      sentence,
      surface,
      rawOccurrence,
      status,
      priority,
      example,
      exampleChinese,
      exampleSource,
      collocation,
      note,
    ] = standardHeaders.map((h) => values[h]);
    for (const name of [
      "英文词条",
      "中文语境释义",
      "书名",
      "原文状态",
      "优先级",
    ])
      if (!values[name]) fail(name, "不能为空；请补全后重新上传");
    if (!chapter && !page) fail("章节 / 页码或位置", "至少填写一项");
    if (title && normalize(title) !== normalize(book))
      fail("书名", "一份文件只能包含一本书，请分开上传");
    title = book;
    if (!["P1", "P2", "P3"].includes(priority))
      fail("优先级", "仅接受 P1/P2/P3，不自动评级");
    if (!["已核对完整句", "已核对节选", "待核对", "待补充"].includes(status))
      fail("原文状态", "请使用模板下拉中的四种状态");
    if (!sentence && status !== "待补充")
      fail("原文状态", "没有原文时请选择待补充");
    if (status === "待补充" && sentence)
      fail("原文状态", "已有片段请改为待核对或已核对节选");
    if (!sentence && (surface || rawOccurrence))
      fail("原句实际词形", "缺少原文时不能指定高亮");
    for (const [name, limit] of [
      ["英文词条", 200],
      ["中文语境释义", 1000],
      ["书名", 200],
      ["章节", 200],
      ["页码或位置", 100],
      ["书中原句或片段", 10000],
      ["原句实际词形", 200],
      ["补充例句", 3000],
      ["例句中文", 3000],
      ["核对备注", 3000],
    ] as const)
      if (values[name].length > limit) fail(name, `最多 ${limit} 个字符`);
    const occurrence = rawOccurrence ? Number(rawOccurrence) : 1;
    if (
      rawOccurrence &&
      (!/^\d+$/.test(rawOccurrence) ||
        !Number.isInteger(occurrence) ||
        occurrence < 1 ||
        occurrence > 99)
    )
      fail("高亮出现序号", "须为 1–99 的整数，留空表示第一次");
    if (
      sentence &&
      (!surface ||
        !highlightParts(sentence, surface, occurrence, true).some(
          (p) => p.highlight,
        ))
    )
      fail(
        "原句实际词形 / 高亮出现序号",
        "请从原文复制准确文字并确认该次出现存在（区分大小写）",
      );
    if (
      example &&
      ![
        "自编",
        "AI生成未核对",
        "AI生成已人工核对",
        "词典（注明名称）",
        "其他（注明来源）",
      ].includes(exampleSource)
    )
      fail("例句来源", "有补充例句时须从下拉选择来源");
    if (!example && (exampleChinese || exampleSource))
      fail("补充例句", "译文或来源已有内容，请补全例句或一并清空");
    if (
      example &&
      ["词典（注明名称）", "其他（注明来源）"].includes(exampleSource) &&
      !note
    )
      fail("核对备注", "请注明词典名称或其他例句的具体来源");
    if (["待核对", "待补充"].includes(status) && !note)
      fail("核对备注", "请写明缺失或待核对的原因");
    all.push({ term, priority });
    counts[priority]++;
    if (all.length > 5000) fail("记录数", "最多接受 5,000 条记录");
    const rowKey = createHash("sha256")
      .update(
        JSON.stringify([
          ...(selected
            ? ["sheet-row-v2", "phrasebud-v1", normalize(book), sheet.name]
            : ["phrasebud-v1", normalize(book)]),
          n,
          normalize(term),
          sentence,
          chapter,
          page,
        ]),
      )
      .digest("hex");
    let data;
    try {
      data = draftSchema.parse({
        term,
        meaning,
        sourceType: "Reading",
        sentence,
        chapter,
        page,
        priority,
        expressionType: /\s/.test(term) ? "phrase" : "word",
        targetSurface: surface,
        note,
        importMetadata: {
          profile: "phrasebud-v1",
          rowKey,
          fileName,
          sheet: sheet.name,
          row: n,
          contextMeaningEnglish: "",
          dictionaryEnglish: "",
          dictionaryChinese: meaning,
          ipa: "",
          partOfSpeech: "",
          rationale: "",
          learningTarget: collocation,
          originalPriority: priority,
          normalizedItem: normalize(term),
          bookCount: "",
          priorityConflict: false,
          excerpt: status === "已核对节选",
          verificationStatus: status,
          highlightOccurrence: occurrence,
          example,
          exampleChinese,
          exampleSource,
        },
      });
    } catch {
      fail("字段长度或内容", "超出支持长度，请缩短词条、释义或原句后重试");
    }
    if (priorities.includes(priority))
      rows.push({
        key: rowKey,
        sheet: sheet.name,
        row: n,
        data: data!,
        warnings: ["待核对", "待补充"].includes(status)
          ? [`原文${status}，尚未核实，不会自动加入复习池`]
          : [],
      });
  }
  if (!all.length)
    throw new AppError(
      `${sheet.name}：没有可导入的记录；请从第 2 行填写正式内容，填写示例页不会入库`,
    );
  return {
    rows,
    all,
    counts,
    detailSheets: 1,
    skippedSheets: workbook.worksheets
      .filter((s) => s.name !== sheet.name)
      .map((s) => s.name),
    title,
  };
}
