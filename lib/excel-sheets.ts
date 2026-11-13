import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadExcelWorkbook } from "./excel-workbook";
import { standardHeaders } from "./standard-import";
import { hashValue, sealChange, openChange } from "./change-preview";
import { AppError } from "./store";
import type {
  SheetInfo,
  SheetSelection,
  WorkbookInspection,
} from "./import-contracts";

export const sheetSelectionSchema = z
  .object({
    mode: z.literal("selected-sheets-v1"),
    inspectionToken: z.string().max(8192),
    selectedSheetIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1, "至少选择一页")
      .max(1000),
    priorities: z
      .array(z.enum(["P1", "P2", "P3"]))
      .min(1, "至少选择一个导入等级")
      .max(3)
      .refine(
        (values) => new Set(values).size === values.length,
        "导入等级不能重复",
      )
      .default(["P1"])
      .transform((values) => values.sort()),
  })
  .strict();
const auxiliary = new Set([
  "填写说明",
  "填写示例",
  "P1 优先掌握",
  "P1 去重复习",
  "优先级说明与统计",
]);
const bebeHeaders = [
  "Circled item",
  "复习优先级（严格版）",
  "Type",
  "Dictionary / core Chinese meaning",
  "Meaning in this context (English)",
  "Sentence / context",
];
const farmHeaders = [
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
export const excelFileHash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");
function headerNames(sheet: ExcelJS.Worksheet, row: number) {
  const names: string[] = [];
  const issues: string[] = [];
  sheet.findRow(row)?.eachCell((c) => {
    if (c.type === ExcelJS.ValueType.Formula) issues.push("表头不能含公式");
    const name = c.text.trim();
    if (name) names.push(name);
  });
  for (const name of new Set(names))
    if (names.filter((n) => n === name).length > 1)
      issues.push(`表头重复：${name}`);
  return { names, issues };
}
export function inventorySheets(
  workbook: ExcelJS.Workbook,
  fileHash: string,
): SheetInfo[] {
  if (workbook.worksheets.length > 1000)
    throw new AppError("工作表过多，最多支持 1,000 页，请拆分文件");
  return workbook.worksheets.map((sheet, order) => {
    const first = headerNames(sheet, 1),
      fifth = headerNames(sheet, 5);
    const hasValues =
      sheet.getRows(1, sheet.rowCount)?.some((row) => row.hasValues) ?? false;
    const markers = [
      sheet.name.trim() === "语料填写" || first.names.includes("英文词条"),
      sheet.findRow(2)?.findCell(1)?.text.startsWith("Our Little Farm ·") ||
        fifth.names.includes("词汇 / 表达"),
      first.names.includes("Circled item"),
    ];
    const profiles = [
      "phrasebud-v1",
      "little-farm-v1",
      "bebe-strict-v1",
    ] as const;
    const matches = markers.flatMap((yes, i) => (yes ? [profiles[i]] : []));
    const base: SheetInfo = {
      sheetId: hashValue([fileHash, order, sheet.name]),
      name: sheet.name,
      order,
      state: sheet.state || "visible",
      role: "unsupported",
      profile: null,
      estimatedRows: null,
      headerIssues: [],
      reason: "无法识别模板，请整理为标准列名后重试",
    };
    if (!hasValues)
      return {
        ...base,
        role: "empty",
        estimatedRows: 0,
        reason: "空白页，不导入",
      };
    if (auxiliary.has(sheet.name.trim()))
      return {
        ...base,
        role: "auxiliary",
        reason: "说明/示例/统计/汇总页不导入；若为正式数据请改为普通页名",
      };
    if (matches.length !== 1)
      return {
        ...base,
        reason: matches.length
          ? "同页出现多种模板标志，无法确定格式"
          : base.reason,
      };
    const profile = matches[0],
      headers = profile === "little-farm-v1" ? fifth : first;
    if (
      profile === "little-farm-v1" &&
      !/^(Preface|Chapter\s+[1-9]\d*)$/i.test(sheet.name)
    )
      return {
        ...base,
        profile,
        reason: "Our Little Farm 数据页名须为 Preface 或 Chapter N",
      };
    const required =
      profile === "phrasebud-v1"
        ? standardHeaders
        : profile === "little-farm-v1"
          ? farmHeaders
          : bebeHeaders;
    const headerIssues = [
      ...headers.issues,
      ...required
        .filter((h) => !headers.names.includes(h))
        .map((h) => `缺少列：${h}`),
    ];
    if (profile === "phrasebud-v1")
      for (const h of headers.names)
        if (!standardHeaders.includes(h)) headerIssues.push(`未知列：${h}`);
    if (profile === "little-farm-v1") {
      if (!sheet.findRow(2)?.findCell(1)?.text.startsWith("Our Little Farm ·"))
        headerIssues.push("第 2 行须保留 Our Little Farm 书名标志");
      if (!headers.names.some((n) => ["来源", "来源·页码"].includes(n)))
        headerIssues.push("缺少来源或来源·页码列");
    }
    let estimatedRows = 0;
    sheet.eachRow((row, n) => {
      if (n <= (profile === "little-farm-v1" ? 5 : 1)) return;
      let nonblank = false;
      row.eachCell((cell) => {
        if (cell.text.trim()) nonblank = true;
      });
      if (nonblank) estimatedRows++;
    });
    return {
      ...base,
      role: "data",
      profile,
      estimatedRows,
      headerIssues,
      reason: headerIssues.length
        ? "表头需修正；选中后无法继续预览"
        : "数据页；逐行内容待检查",
    };
  });
}
export async function inspectExcel(
  buffer: Buffer,
  fileName: string,
  generation: string,
): Promise<WorkbookInspection> {
  const workbook = await loadExcelWorkbook(buffer, fileName);
  const fileHash = excelFileHash(buffer),
    sheets = inventorySheets(workbook, fileHash);
  const inspection: WorkbookInspection = {
    version: 1,
    fileName,
    fileHash,
    sheets,
    inspectionToken: sealChange("sheet-inspection-v1", {
      version: 1,
      fileHash,
      manifest: hashValue(sheets),
      generation,
    }),
  };
  if (Buffer.byteLength(JSON.stringify(inspection)) > 1024 * 1024)
    throw new AppError(
      "工作表清单超过 1 MB，请减少页数或缩短表头后重新上传",
      413,
    );
  return inspection;
}
export function selectedSheets(
  workbook: ExcelJS.Workbook,
  buffer: Buffer,
  input: SheetSelection,
  generation: string,
) {
  const selection = sheetSelectionSchema.parse(input);
  const proof = openChange<{
    version: number;
    fileHash: string;
    manifest: string;
    generation: string;
  }>(selection.inspectionToken, "sheet-inspection-v1");
  const fileHash = excelFileHash(buffer),
    sheets = inventorySheets(workbook, fileHash);
  if (
    proof.version !== 1 ||
    proof.fileHash !== fileHash ||
    proof.manifest !== hashValue(sheets) ||
    proof.generation !== generation
  )
    throw new AppError(
      "文件或学习库已变化，请重新检查工作表",
      409,
      "PREVIEW_STALE",
    );
  const ids = new Set(selection.selectedSheetIds);
  if (ids.size !== selection.selectedSheetIds.length)
    throw new AppError("不能重复选择同一工作表");
  const chosen = sheets.filter((s) => ids.has(s.sheetId));
  if (chosen.length !== ids.size || chosen.some((s) => s.role !== "data"))
    throw new AppError("包含无效或不可导入的工作表，请重新选择");
  if (new Set(chosen.map((s) => s.profile)).size !== 1)
    throw new AppError("所选工作表必须属于同一种模板，请分开选择");
  const bad = chosen.find((s) => s.headerIssues.length);
  if (bad)
    throw new AppError(
      `${bad.name} 第 ${bad.profile === "little-farm-v1" ? 5 : 1} 行表头：${bad.headerIssues.join("；")}`,
    );
  return {
    fileHash,
    chosen,
    priorities: selection.priorities,
    skipped: sheets.filter((s) => !ids.has(s.sheetId)).map((s) => s.name),
  };
}
