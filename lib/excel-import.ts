import ExcelJS from "exceljs";
import {
  createHash,
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { AppError, type Store } from "./store";
import { draftSchema, normalize, type DraftInput } from "./contracts";
import type {
  ImportPreview,
  ImportRow,
  ImportGroup,
  ImportChoice,
  ImportResult,
} from "./import-contracts";
import { inflateRawSync } from "node:zlib";

const MAX_FILE = 5 * 1024 * 1024;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const state = globalThis as unknown as { readwordsImportSecret?: Buffer };
const secret = () => (state.readwordsImportSecret ??= randomBytes(32));
const sign = (s: string) =>
  createHmac("sha256", secret()).update(s).digest("base64url");

// Bound the actual archive expansion before asking the XLSX parser to decompress it.
function checkArchive(buffer: Buffer) {
  if (buffer.length > MAX_FILE)
    throw new AppError("Excel 文件不能超过 5 MB", 413);
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new AppError("文件不是有效的 .xlsx 工作簿");
  const count = buffer.readUInt16LE(end + 10),
    size = buffer.readUInt32LE(end + 12),
    offset = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    count > 2000 ||
    offset + size > end
  )
    throw new AppError("不支持此 Excel 压缩结构");
  let cursor = offset,
    total = 0;
  for (let n = 0; n < count; n++) {
    if (
      cursor + 46 > offset + size ||
      buffer.readUInt32LE(cursor) !== 0x02014b50
    )
      throw new AppError("Excel 文件目录损坏");
    if (buffer.readUInt16LE(cursor + 8) & 1)
      throw new AppError("不支持加密工作簿");
    total += buffer.readUInt32LE(cursor + 24);
    if (total > 40 * 1024 * 1024)
      throw new AppError("Excel 解压内容超过 40 MB，请缩小文件", 413);
    const compressed = buffer.readUInt32LE(cursor + 20),
      length = buffer.readUInt32LE(cursor + 24),
      local = buffer.readUInt32LE(cursor + 42),
      method = buffer.readUInt16LE(cursor + 10);
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50)
      throw new AppError("Excel 压缩条目无效");
    const start =
      local +
      30 +
      buffer.readUInt16LE(local + 26) +
      buffer.readUInt16LE(local + 28);
    if (start + compressed > offset || ![0, 8].includes(method))
      throw new AppError("Excel 压缩条目不受支持");
    try {
      const raw =
        method === 0
          ? buffer.subarray(start, start + compressed)
          : inflateRawSync(buffer.subarray(start, start + compressed), {
              maxOutputLength: Math.max(1, length),
            });
      if (raw.length !== length) throw Error();
    } catch {
      throw new AppError("Excel 压缩内容大小不一致或已损坏");
    }
    cursor +=
      46 +
      buffer.readUInt16LE(cursor + 28) +
      buffer.readUInt16LE(cursor + 30) +
      buffer.readUInt16LE(cursor + 32);
  }
  if (cursor !== offset + size) throw new AppError("Excel 文件目录无效");
}
type Payload = { expires: number; fileName: string; rows: ImportRow[] };
function makeToken(payload: Payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}
function readToken(token: string): Payload {
  if (token.length > 3 * 1024 * 1024) throw new AppError("导入预览过大");
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra)
    throw new AppError("导入预览无效，请重新上传");
  const actual = Buffer.from(signature),
    expected = Buffer.from(sign(encoded));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AppError("预览已失效，请重新上传（服务重启后需要重新预览）", 409);
  const payload = JSON.parse(
    Buffer.from(encoded, "base64url").toString(),
  ) as Payload;
  if (payload.expires < Date.now())
    throw new AppError("预览已超过 30 分钟，请重新上传", 409);
  return payload;
}
const groupKey = (row: ImportRow) =>
  hash(JSON.stringify([normalize(row.data.term), row.data.meaning]));
export function groupsFor(rows: ImportRow[], store: Store): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        term: row.data.term,
        meaning: row.data.meaning,
        rows: [],
        candidates: store.candidates(row.data.term).map((e) => ({
          id: e.id,
          meaning: e.meaning,
          priority: e.priority,
          lifecycle: e.lifecycle,
        })),
      };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()];
}
export async function previewExcel(
  buffer: Buffer,
  fileName: string,
  store: Store,
): Promise<ImportPreview> {
  if (!/\.xlsx$/i.test(fileName) || fileName.length > 250)
    throw new AppError("请选择 .xlsx 文件（不支持 .xls / .xlsm）");
  checkArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new AppError("无法读取工作簿，请确认文件未加密且格式正确");
  }
  const rows: ImportRow[] = [],
    all: { term: string; priority: string }[] = [],
    skippedSheets: string[] = [];
  const counts: Record<string, number> = { P1: 0, P2: 0, P3: 0 };
  let detailSheets = 0;
  for (const sheet of workbook.worksheets) {
    const headers = new Map<string, number>();
    sheet.getRow(1).eachCell((c, i) => headers.set(c.text.trim(), i));
    if (!headers.has("Circled item") || !headers.has("复习优先级（严格版）")) {
      skippedSheets.push(sheet.name);
      continue;
    }
    for (const required of [
      "Type",
      "Dictionary / core Chinese meaning",
      "Meaning in this context (English)",
      "Sentence / context",
    ]) {
      if (!headers.has(required))
        throw new AppError(`${sheet.name} 缺少列：${required}`);
    }
    detailSheets++;
    if (sheet.rowCount > 10000 || sheet.columnCount > 100)
      throw new AppError("工作表超出支持范围");
    const text = (row: ExcelJS.Row, name: string) => {
      const column = headers.get(name);
      if (!column) return "";
      const cell = row.getCell(column);
      if (cell.type === ExcelJS.ValueType.Formula)
        throw new AppError(
          `${sheet.name} 第 ${row.number} 行含公式，请改为纯值后导入`,
        );
      return cell.text.trim();
    };
    for (let index = 2; index <= sheet.rowCount; index++) {
      const row = sheet.getRow(index);
      if (!row.hasValues) continue;
      const term = text(row, "Circled item"),
        priority = text(row, "复习优先级（严格版）");
      if (!term || !["P1", "P2", "P3"].includes(priority))
        throw new AppError(`${sheet.name} 第 ${index} 行的词条或严格等级无效`);
      counts[priority]++;
      all.push({ term, priority });
      if (all.length > 5000) throw new AppError("最多支持 5,000 行章节明细");
      if (priority !== "P1") continue;
      const meaning = text(row, "Dictionary / core Chinese meaning"),
        sentence = text(row, "Sentence / context"),
        page = text(row, "Page") || text(row, "原文页码");
      const rowKey = hash(
        JSON.stringify([
          "bebe-strict-v1",
          sheet.name,
          index,
          normalize(term),
          sentence,
          page,
        ]),
      );
      const originalType = text(row, "Type");
      if (
        ![
          "word",
          "phrase",
          "sentence",
          "collocation",
          "chunk",
          "sentence_pattern",
        ].includes(originalType)
      )
        throw new AppError(`${sheet.name} 第 ${index} 行的 Type 无法识别`);
      const excerpt = /\.\.\.|…/.test(sentence),
        warnings: string[] = [];
      if (!page) warnings.push("无页码");
      if (excerpt) warnings.push("上下文为节选");
      const data = draftSchema.parse({
        term,
        sourceType: "Reading",
        meaning,
        expressionType: originalType === "sentence" ? "chunk" : originalType,
        priority: "P1",
        eventKind: "exposure",
        whySaved: "useful",
        sentence,
        chapter: sheet.name,
        page,
        importMetadata: {
          profile: "bebe-strict-v1",
          rowKey,
          fileName,
          sheet: sheet.name,
          row: index,
          contextMeaningEnglish: text(row, "Meaning in this context (English)"),
          dictionaryEnglish: text(row, "Dictionary / core English meaning"),
          dictionaryChinese: meaning,
          ipa: text(row, "IPA (Oxford-style, AmE where applicable)"),
          partOfSpeech: text(row, "Part of speech"),
          rationale: text(row, "分级理由（语义复核）"),
          learningTarget: text(row, "复习目标或搭配"),
          originalPriority: text(row, "原复习优先级"),
          normalizedItem: text(row, "归一词条（去重口径）"),
          bookCount: text(row, "全表词条出现次数"),
          priorityConflict: false,
          excerpt,
        },
      });
      if (!data.meaning || !data.importMetadata?.contextMeaningEnglish)
        throw new AppError(
          `${sheet.name} 第 ${index} 行缺少释义，请补全后导入`,
        );
      rows.push({ key: rowKey, sheet: sheet.name, row: index, data, warnings });
    }
  }
  if (!detailSheets)
    throw new AppError(
      "未找到章节明细：需要 Circled item 和复习优先级（严格版）列",
    );
  const levels = new Map<string, Set<string>>();
  for (const r of all) {
    const k = normalize(r.term);
    if (!levels.has(k)) levels.set(k, new Set());
    levels.get(k)!.add(r.priority);
  }
  for (const row of rows) {
    if (levels.get(normalize(row.data.term))!.size > 1) {
      row.data.importMetadata!.priorityConflict = true;
      row.warnings.push("其他章节有不同等级，本次仅取严格 P1");
    }
  }
  return {
    token: makeToken({ expires: Date.now() + 30 * 60 * 1000, fileName, rows }),
    fileName,
    totalRows: all.length,
    counts,
    detailSheets,
    skippedSheets,
    groups: groupsFor(rows, store),
    excludedRows: all.length - rows.length,
    warnings: [
      "中文列是词典义项；英文语境释义将单独保留，不冒充中文语境翻译。",
      "只按实际词条与相同中文义项分组，不按变形或搭配自动合并。",
    ],
  };
}
export const commitSchema = z.object({
  token: z.string().max(3 * 1024 * 1024),
  sourceId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  confirmed: z.literal(true),
  choices: z
    .array(
      z.object({
        groupKey: z.string().length(64),
        action: z.enum(["new", "split", "existing", "skip"]),
        expressionId: z.uuid().optional(),
      }),
    )
    .max(1000),
});
export function commitExcel(store: Store, input: unknown): ImportResult {
  const options = commitSchema.parse(input),
    payload = readToken(options.token),
    groups = groupsFor(payload.rows, store);
  const choices = new Map(options.choices.map((c) => [c.groupKey, c]));
  if (
    choices.size !== options.choices.length ||
    choices.size !== groups.length ||
    groups.some((g) => !choices.has(g.key))
  )
    throw new AppError("请为每个分组明确选择导入方式");
  if (options.choices.every((c) => c.action === "skip"))
    throw new AppError("至少选择一个 P1 分组");
  return store.transaction(() => {
    let sourceId = options.sourceId;
    if (sourceId) {
      const source = store.getSource(sourceId);
      if (source.type !== "Reading" || source.lifecycle !== "active")
        throw new AppError("请选择有效的 Reading 来源");
    } else {
      const existing = store
        .sources()
        .filter(
          (s) =>
            s.type === "Reading" &&
            normalize(s.title) === normalize(options.title),
        );
      // Recover safely if the first success response was lost: reuse only when all
      // selected rows already belong to the one exact source. Never silently merge.
      const selected = groups
        .filter((g) => choices.get(g.key)!.action !== "skip")
        .flatMap((g) => g.rows);
      if (
        existing.length === 1 &&
        existing[0].lifecycle === "active" &&
        selected.every((r) =>
          store.one(
            "SELECT id FROM contexts WHERE source_id=? AND json_extract(data,'$.importMetadata.rowKey')=?",
            existing[0].id,
            r.key,
          ),
        )
      )
        sourceId = existing[0].id;
      else if (existing.length > 0)
        throw new AppError(
          "已有同名来源，请选择复用它（归档来源须先恢复）",
          409,
        );
      else
        sourceId = store.createSource({
          id: randomUUID(),
          title: options.title,
          type: "Reading",
          readingStatus: "finished",
        }).id;
    }
    const result: ImportResult = {
      sourceId,
      createdExpressions: 0,
      importedContexts: 0,
      skippedContexts: 0,
    };
    for (const group of groups) {
      const choice = choices.get(group.key)!;
      if (choice.action === "skip") continue;
      let expressionId = choice.expressionId;
      if (choice.action === "existing") {
        const candidate = store
          .candidates(group.term)
          .find((e) => e.id === expressionId);
        if (!candidate || candidate.lifecycle !== "active")
          throw new AppError(
            `“${group.term}”的目标义项不可用，请重新预览`,
            409,
          );
        if (candidate.priority !== "P1")
          throw new AppError(
            `“${group.term}”的既有义项不是 P1；请新建或先调整等级`,
            409,
          );
      } else expressionId = undefined;
      for (const row of group.rows) {
        const known = store.one(
          "SELECT id FROM contexts WHERE source_id=? AND json_extract(data,'$.importMetadata.rowKey')=?",
          sourceId,
          row.key,
        );
        if (known) {
          result.skippedContexts++;
          continue;
        }
        if (choice.action === "split") expressionId = undefined;
        const d = {
          ...row.data,
          sourceId,
          meaning: row.data.importMetadata!.contextMeaningEnglish,
        };
        // The Expression keeps the provided dictionary Chinese sense; Context stores the
        // original English contextual meaning. Neither is invented or silently translated.
        const draft = store.createDraft(randomUUID(), d);
        const saved = store.saveDraft(draft.id, {
          version: 1,
          expressionId,
          newSense: true,
        });
        if (!expressionId) {
          result.createdExpressions++;
          store.db
            .prepare("UPDATE expressions SET meaning=? WHERE id=?")
            .run(group.meaning, saved.expressionId!);
        }
        expressionId = saved.expressionId!;
        result.importedContexts++;
      }
    }
    return result;
  });
}
