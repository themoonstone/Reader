import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { AppError } from "./store";
import { draftSchema, normalize, type DraftInput } from "./contracts";
import type { ImportRow } from "./import-contracts";

const required = [
  "词汇 / 表达",
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
function headersFor(sheet: ExcelJS.Worksheet) {
  const headers = new Map<string, number>();
  sheet.getRow(5).eachCell((cell, column) => {
    const name = cell.text.trim();
    if (headers.has(name))
      throw new AppError(`${sheet.name} 表头重复：${name}`);
    headers.set(name, column);
  });
  return headers;
}
function isFarm(sheet: ExcelJS.Worksheet) {
  return (
    sheet.getCell("A2").text.startsWith("Our Little Farm ·") &&
    sheet.getCell("A5").text.trim() === "词汇 / 表达"
  );
}
export function farmType(
  term: string,
  original: string,
): DraftInput["expressionType"] {
  if (/\bpattern\b/i.test(original)) return "sentence_pattern";
  if (/\b(idiom|saying|sentence|wordplay)\b/i.test(original)) return "chunk";
  return /\s/.test(term.trim()) ? "phrase" : "word";
}
/** Separate adapter: never changes bebe-strict-v1 headers, row keys or mappings. */
export function parseLittleFarm(workbook: ExcelJS.Workbook, fileName: string) {
  if (!workbook.worksheets.some(isFarm)) return null;
  if (
    workbook.worksheets.some((s) => {
      const headers = new Set<string>();
      s.getRow(1).eachCell((cell) => headers.add(cell.text.trim()));
      return headers.has("Circled item") && headers.has("复习优先级（严格版）");
    })
  )
    throw new AppError("一次导入只接受一种表格模板，请分开上传两本书");
  const rows: ImportRow[] = [],
    all: { term: string; priority: string }[] = [],
    skippedSheets: string[] = [];
  const counts: Record<string, number> = { P1: 0, P2: 0, P3: 0 };
  let detailSheets = 0;
  for (const sheet of workbook.worksheets) {
    // Summary has the same columns as detail: exclude by role before parsing rows.
    if (!/^(Preface|Chapter\s+[1-9]\d*)$/i.test(sheet.name)) {
      skippedSheets.push(sheet.name);
      continue;
    }
    if (!isFarm(sheet))
      throw new AppError(
        `${sheet.name} 的书名或第 5 行表头不匹配，请检查章节明细`,
      );
    if (sheet.rowCount > 10000 || sheet.columnCount > 100)
      throw new AppError("工作表超出支持范围");
    const headers = headersFor(sheet);
    for (const name of required)
      if (!headers.has(name))
        throw new AppError(`${sheet.name} 缺少列：${name}`);
    const locationColumn = headers.has("来源·页码")
      ? "来源·页码"
      : headers.has("来源")
        ? "来源"
        : null;
    if (!locationColumn)
      throw new AppError(`${sheet.name} 缺少来源或来源·页码列`);
    detailSheets++;
    const text = (row: ExcelJS.Row, name: string) => {
      const cell = row.getCell(headers.get(name)!);
      if (cell.type === ExcelJS.ValueType.Formula)
        throw new AppError(
          `${sheet.name} 第 ${row.number} 行含公式，请改为纯值后导入`,
        );
      return cell.text.trim();
    };
    for (let index = 6; index <= sheet.rowCount; index++) {
      const row = sheet.getRow(index);
      if (!row.hasValues) continue;
      const term = text(row, "词汇 / 表达"),
        priority = text(row, "优先级");
      if (!term || !["P1", "P2", "P3"].includes(priority))
        throw new AppError(`${sheet.name} 第 ${index} 行的词条或等级无效`);
      all.push({ term, priority });
      counts[priority]++;
      if (all.length > 5000) throw new AppError("最多支持 5,000 行章节明细");
      if (priority !== "P1") continue;
      const meaning = text(row, "中文释义"),
        english = text(row, "本书语境义（英文）"),
        sentence = text(row, "原文片段"),
        originalType = text(row, "词性 / 类型"),
        rawLocation = text(row, locationColumn);
      if (!meaning || !english || !originalType)
        throw new AppError(`${sheet.name} 第 ${index} 行缺少释义或词性 / 类型`);
      const location = /^(.+?)·\s*(\d[\d,，、\s\-–—]*)$/.exec(rawLocation);
      const page = location?.[2].trim() || "",
        sourceMark = location?.[1].trim() || rawLocation;
      const rowKey = createHash("sha256")
        .update(
          JSON.stringify([
            "little-farm-v1",
            sheet.name,
            index,
            normalize(term),
            sentence,
            page,
          ]),
        )
        .digest("hex");
      const data = draftSchema.parse({
        term,
        sourceType: "Reading",
        meaning,
        expressionType: farmType(term, originalType),
        priority: "P1",
        eventKind: "exposure",
        whySaved: "useful",
        sentence,
        chapter: sheet.name,
        page,
        importMetadata: {
          profile: "little-farm-v1",
          rowKey,
          fileName,
          sheet: sheet.name,
          row: index,
          contextMeaningEnglish: english,
          dictionaryEnglish: text(row, "核心英文释义"),
          dictionaryChinese: meaning,
          ipa: text(row, "美音 IPA"),
          partOfSpeech: originalType,
          rationale: text(row, "学习理由"),
          learningTarget: "",
          originalPriority: priority,
          normalizedItem: "",
          bookCount: "",
          priorityConflict: false,
          excerpt: true,
          sourceMark,
          rawSourceLocation: rawLocation,
          simpleParaphrase: text(row, "简单英文释义 / 改写"),
        },
      });
      rows.push({
        key: rowKey,
        sheet: sheet.name,
        row: index,
        data,
        warnings: [
          ...(!page ? ["无页码"] : []),
          "原表片段；一行仅记录一次遇见",
        ],
      });
    }
  }
  if (!detailSheets)
    throw new AppError(
      "未找到 Our Little Farm 前言或章节明细，不能只上传 P1 汇总表",
    );
  return { rows, all, counts, skippedSheets, detailSheets };
}
