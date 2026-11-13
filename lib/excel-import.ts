import ExcelJS from "exceljs";
import { selectedSheets } from "./excel-sheets";
import { foldSheetRows } from "./sheet-duplicates";
import { loadExcelWorkbook } from "./excel-workbook";
import { parseStandard, validateWorkbookFormat } from "./standard-import";
import { parseLittleFarm } from "./little-farm-import";
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
  ImportDiff,
  ImportDiffRow,
  SheetSelection,
  ImportScope,
} from "./import-contracts";
import {
  materialState,
  hashValue,
  sealChange,
  openChange,
} from "./change-preview";
import { snapshotBeforeChange } from "./backup";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const state = globalThis as unknown as { readwordsImportSecret?: Buffer };
const secret = () => (state.readwordsImportSecret ??= randomBytes(32));
const sign = (s: string) =>
  createHmac("sha256", secret()).update(s).digest("base64url");

type Payload = {
  expires: number;
  fileName: string;
  rows: ImportRow[];
  scope?: ImportScope;
};
function makeToken(payload: Payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${encoded}.${sign(encoded)}`;
  if (token.length > 3 * 1024 * 1024)
    throw new AppError("导入预览过大，请减少所选页/行再检查", 413);
  return token;
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
const importMeaning = (row: ImportRow) =>
  row.data.importMetadata?.profile === "phrasebud-v1"
    ? row.data.meaning
    : row.data.importMetadata!.contextMeaningEnglish;
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
  selection?: SheetSelection,
): Promise<ImportPreview> {
  const generation = store.generation;
  const workbook = await loadExcelWorkbook(buffer, fileName);
  const range = selection
    ? selectedSheets(workbook, buffer, selection, generation)
    : null;
  if (
    range &&
    range.chosen.reduce((n, s) => n + (s.estimatedRows || 0), 0) > 5000
  )
    throw new AppError("所选工作表合计最多支持 5,000 条数据行（包含 P2/P3）");
  let standard: ReturnType<typeof parseStandard> | null = null;
  if (range?.chosen[0].profile === "phrasebud-v1") {
    for (const info of range.chosen) {
      const page = parseStandard(
        workbook,
        fileName,
        info.name,
        true,
        range.priorities,
      );
      if (!standard) standard = page;
      else {
        if (normalize(standard.title) !== normalize(page.title))
          throw new AppError(`${info.name}：所选工作表书名不一致，请分开选择`);
        standard.rows.push(...page.rows);
        standard.all.push(...page.all);
        for (const level of ["P1", "P2", "P3"])
          standard.counts[level] += page.counts[level];
        standard.detailSheets++;
      }
    }
  } else if (!range && validateWorkbookFormat(workbook))
    standard = parseStandard(workbook, fileName);
  const scopedWorkbook = range ? new ExcelJS.Workbook() : workbook;
  if (range)
    for (const info of range.chosen)
      scopedWorkbook.addWorksheet(info.name).model = workbook.getWorksheet(
        info.name,
      )!.model;
  const farm =
    standard ??
    (range?.chosen[0].profile === "bebe-strict-v1"
      ? null
      : parseLittleFarm(scopedWorkbook, fileName, !!range, range?.priorities));
  const rows: ImportRow[] = farm?.rows ?? [],
    all: { term: string; priority: string }[] = farm?.all ?? [],
    skippedSheets: string[] = farm?.skippedSheets ?? [];
  const counts: Record<string, number> = farm?.counts ?? {
    P1: 0,
    P2: 0,
    P3: 0,
  };
  let detailSheets = farm?.detailSheets ?? 0;
  for (const sheet of farm ? [] : scopedWorkbook.worksheets) {
    const headers = new Map<string, number>();
    sheet.getRow(1).eachCell((c, i) => {
      const name = c.text.trim();
      if (!name) return;
      if (headers.has(name))
        throw new AppError(`${sheet.name} 表头重复：${name}`);
      headers.set(name, i);
    });
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
      if (priority !== "P1" && !range) continue;
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
        priority,
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
      if (
        (range?.priorities ?? ["P1"]).includes(priority as "P1" | "P2" | "P3")
      )
        rows.push({
          key: rowKey,
          sheet: sheet.name,
          row: index,
          data,
          warnings,
        });
    }
  }
  if (range && all.length > 5000)
    throw new AppError("所选工作表合计最多支持 5,000 条数据行（包含 P2/P3）");
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
      row.warnings.push(
        range
          ? "所选页面同词条有不同等级；各语境保留原等级"
          : "其他章节有不同等级，本次仅取严格 P1",
      );
    }
  }
  const book = standard
    ? standard.title
    : farm
      ? "Our Little Farm"
      : "Bringing Up Bébé";
  const folded = range ? foldSheetRows(rows, book) : { rows, duplicates: [] };
  if (new Set(folded.rows.map((r) => r.key)).size !== folded.rows.length)
    throw new AppError("导入行标识冲突，请核对重复行或拆分文件");
  const groups = groupsFor(folded.rows, store);
  if (groups.length > 1000)
    throw new AppError("最多支持 1,000 个义项分组，请减少所选页/行");
  const scope: ImportScope | undefined = range
    ? {
        version: 2,
        mode: "selected-sheets-v1",
        generation,
        fileHash: range.fileHash,
        selectedSheets: range.chosen.map(({ sheetId, name }) => ({
          sheetId,
          name,
        })),
        book,
        fileDuplicateCount: rows.length - folded.rows.length,
        priorities: range.priorities,
      }
    : undefined;
  return {
    ...(scope ? { selection: scope, fileDuplicates: folded.duplicates } : {}),
    profile: standard
      ? "phrasebud-v1"
      : farm
        ? "little-farm-v1"
        : "bebe-strict-v1",
    formatLabel: standard
      ? "PhraseBud v1 标准语料模板"
      : farm
        ? "Our Little Farm 章节词汇表"
        : "Bringing Up Bébé 严格分级表",
    suggestedTitle: standard
      ? standard.title
      : farm
        ? "Our Little Farm"
        : "Bringing Up Bébé",
    token: makeToken({
      expires: Date.now() + 30 * 60 * 1000,
      fileName,
      rows: folded.rows,
      ...(scope ? { scope } : {}),
    }),
    fileName,
    totalRows: all.length,
    counts,
    detailSheets,
    skippedSheets: range?.skipped ?? skippedSheets,
    groups,
    excludedRows: all.length - rows.length,
    warnings: [
      standard
        ? "保留中文语境义、原文核对状态、高亮词形、补充例句与来源；待核对内容不视为原书准确引文。"
        : farm
          ? "保留原表中文释义与英文语境义；原文片段和学习改写分开保存。合并页码不拆分次数。"
          : "中文列是词典义项；英文语境释义将单独保留，不冒充中文语境翻译。",
      "只按实际词条与相同中文义项分组，不按变形或搭配自动合并。",
    ],
  };
}
export const commitSchema = z.object({
  token: z.string().max(3 * 1024 * 1024),
  sourceId: z.uuid().optional(),
  title: z.string().trim().min(1).max(200),
  confirmed: z.literal(true),
  separateSource: z.boolean().optional(),
  diffToken: z.string().max(8192).optional(),
  updates: z
    .record(z.string().length(64), z.enum(["keep", "update", "add"]))
    .optional(),
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
type ImportOptions = z.infer<typeof commitSchema>;
function chosenSource(store: Store, o: ImportOptions) {
  if (o.sourceId) {
    if (o.separateSource) throw new AppError("独立新建和复用来源不能同时选择");
    const s = store.getSource(o.sourceId);
    if (s.type !== "Reading" || s.lifecycle !== "active")
      throw new AppError("请选择有效的 Reading 来源");
    return s;
  }
  const same = store
    .sources()
    .filter(
      (s) => s.type === "Reading" && normalize(s.title) === normalize(o.title),
    );
  if (o.separateSource) return undefined;
  if (same.length === 1 && same[0].lifecycle === "active") return same[0];
  if (same.length)
    throw new AppError(
      "已有多个同名或归档来源，请明确选择来源或新建独立来源",
      409,
    );
}
function scopedSource(store: Store, o: ImportOptions, payload: Payload) {
  if (payload.scope) {
    if (
      payload.scope.version !== 2 ||
      payload.scope.mode !== "selected-sheets-v1" ||
      payload.scope.generation !== store.generation
    )
      throw new AppError(
        "学习库或导入预览已变化，请重新检查工作表",
        409,
        "PREVIEW_STALE",
      );
    if (normalize(o.title) !== normalize(payload.scope.book))
      throw new AppError("来源标题与所选书名不一致，请核对");
  }
  const source = chosenSource(store, o);
  if (
    payload.scope &&
    source &&
    normalize(source.title) !== normalize(payload.scope.book)
  )
    throw new AppError("所选来源与工作表书名不一致，请更换来源");
  return source;
}
function selectionHash(o: ImportOptions) {
  return hashValue([
    o.token,
    o.sourceId || "",
    o.title,
    o.separateSource || false,
    [...o.choices].sort((a, b) => a.groupKey.localeCompare(b.groupKey)),
  ]);
}
function diffRows(
  store: Store,
  payload: Payload,
  o: ImportOptions,
): ImportDiff["rows"] {
  const source = scopedSource(store, o, payload);
  const known = source
    ? store
        .all(
          "SELECT c.*,e.lifecycle AS expression_lifecycle FROM contexts c JOIN expressions e ON e.id=c.expression_id WHERE c.source_id=? ORDER BY c.id",
          source.id,
        )
        .map((r) => ({
          id: String(r.id),
          lifecycle: String(r.lifecycle),
          expression_lifecycle: String(r.expression_lifecycle),
          parsed: JSON.parse(String(r.data)) as DraftInput,
        }))
    : [];
  const selected = new Map(
    o.choices.map((c) => [c.groupKey, c.action !== "skip"]),
  );
  const result: ImportDiff["rows"] = payload.rows.map((row) => {
    const d = row.data,
      meta = d.importMetadata!;
    const sameTerm = (old: (typeof known)[number]) =>
      normalize(old.parsed.term) === normalize(d.term);
    let matches = known.filter(
      (old) => old.parsed.importMetadata?.rowKey === row.key,
    );
    let reason = "相同导入明细";
    if (!matches.length && payload.scope && meta.profile === "phrasebud-v1") {
      const legacyKey = hashValue([
        "phrasebud-v1",
        normalize(payload.scope.book),
        row.row,
        normalize(d.term),
        d.sentence,
        d.chapter,
        d.page,
      ]);
      matches = known.filter(
        (old) =>
          old.parsed.importMetadata?.rowKey === legacyKey &&
          old.parsed.importMetadata.profile === meta.profile &&
          old.parsed.importMetadata.sheet === row.sheet &&
          sameTerm(old) &&
          old.parsed.sentence === d.sentence &&
          old.parsed.chapter === d.chapter &&
          old.parsed.page === d.page,
      );
    }
    if (!matches.length) {
      matches = known.filter(
        (old) =>
          (!payload.scope ||
            old.parsed.importMetadata?.profile === meta.profile) &&
          sameTerm(old) &&
          old.parsed.sentence === d.sentence &&
          old.parsed.chapter === d.chapter &&
          old.parsed.page === d.page,
      );
      reason = "相同词条、原句与位置（文件重排不重复添加）";
    }
    if (!matches.length) {
      matches = known.filter(
        (old) =>
          sameTerm(old) &&
          old.parsed.importMetadata?.profile === meta.profile &&
          old.parsed.importMetadata.sheet === meta.sheet &&
          old.parsed.importMetadata.row === meta.row &&
          !payload.rows.some(
            (other) =>
              other.key !== row.key &&
              normalize(other.data.term) === normalize(old.parsed.term) &&
              other.data.sentence === old.parsed.sentence &&
              other.data.chapter === old.parsed.chapter,
          ),
      );
      reason = "原表同一位置可能修订，请核对新旧内容后选择";
    }
    const base = {
      key: row.key,
      term: d.term,
      selected: selected.get(groupKey(row)) || false,
      reason,
      fields: [] as ImportDiffRow["fields"],
    };
    if (matches.length > 1)
      return {
        ...base,
        status: "ambiguous" as const,
        reason: "匹配到多个旧语境，保留原数据；请先在详情中核对",
      };
    if (!matches.length)
      return { ...base, status: "new" as const, reason: "原库没有匹配语境" };
    const old = matches[0];
    if (
      old.lifecycle !== "active" ||
      old.expression_lifecycle !== "active" ||
      old.parsed.importMetadata?.profile !== meta.profile
    )
      return {
        ...base,
        status: "protected" as const,
        contextId: String(old.id),
        reason: "旧记录已归档/删除或来自其他采集方式，本次保留，不自动恢复",
      };
    const incoming = { ...d, meaning: importMeaning(row) };
    const fields: ImportDiffRow["fields"] = [];
    for (const key of [
      "sentence",
      "chapter",
      "page",
      "meaning",
      ...(payload.scope ? ["priority" as const] : []),
      ...(meta.profile === "phrasebud-v1" ? ["targetSurface" as const] : []),
    ] as const)
      if (old.parsed[key] !== incoming[key])
        fields.push({
          field: key,
          before: old.parsed[key],
          after: incoming[key],
        });
    for (const key of Object.keys(meta) as (keyof typeof meta)[]) {
      if (
        [
          "rowKey",
          "fileName",
          "row",
          "sheet",
          ...(payload.scope ? ["priorityConflict"] : []),
        ].includes(key)
      )
        continue;
      const before = old.parsed.importMetadata?.[key],
        after = meta[key];
      if ((before ?? "") !== (after ?? ""))
        fields.push({
          field: `导入.${key}`,
          before: String(before ?? ""),
          after: String(after ?? ""),
        });
    }
    return {
      ...base,
      contextId: String(old.id),
      fields,
      status: fields.length ? ("changed" as const) : ("duplicate" as const),
    };
  });
  const shared = new Map<string, ImportDiffRow[]>();
  for (const row of result)
    if (row.contextId) {
      const group = shared.get(row.contextId) || [];
      group.push(row);
      shared.set(row.contextId, group);
    }
  for (const group of shared.values())
    if (group.length > 1 && group.some((r) => r.status === "changed"))
      for (const row of group) {
        row.status = "ambiguous";
        row.reason = "本次多行匹配同一旧记录，保留旧值；如为不同义项请明确新建";
      }
  return result;
}
export function previewImportDiff(store: Store, input: unknown): ImportDiff {
  const o = commitSchema.parse(input),
    payload = readToken(o.token);
  return store.transaction(
    () => {
      const groups = groupsFor(payload.rows, store),
        keys = new Set(o.choices.map((c) => c.groupKey));
      if (
        keys.size !== groups.length ||
        keys.size !== o.choices.length ||
        groups.some((g) => !keys.has(g.key))
      )
        throw new AppError("请为每个分组选择导入方式");
      const rows = diffRows(store, payload, o),
        counts: ImportDiff["counts"] = {
          new: 0,
          duplicate: 0,
          changed: 0,
          protected: 0,
          ambiguous: 0,
        };
      for (const r of rows) if (r.selected) counts[r.status]++;
      return {
        sourceId: scopedSource(store, o, payload)?.id,
        rows,
        counts,
        token: sealChange("import-diff", {
          selection: selectionHash(o),
          state: materialState(store),
        }),
      };
    },
    { readOnly: true },
  );
}
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
    throw new AppError(
      payload.scope ? "至少选择一个语境分组" : "至少选择一个 P1 分组",
    );
  return store.transaction(() => {
    scopedSource(store, options, payload);
    if (payload.scope && !options.diffToken)
      throw new AppError("请先对比本次导入再确认", 409);
    if (options.diffToken) {
      const proof = openChange<{ selection: string; state: string }>(
        options.diffToken,
        "import-diff",
      );
      if (
        proof.selection !== selectionHash(options) ||
        proof.state !== materialState(store)
      )
        throw new AppError(
          "差异预览后学习库或选择已变化，请重新对比",
          409,
          "PREVIEW_STALE",
        );
    }
    const differences = diffRows(store, payload, options),
      byKey = new Map(differences.map((d) => [d.key, d]));
    const updateKeys = Object.entries(options.updates || {})
      .filter(([, v]) => v === "update")
      .map(([k]) => k);
    const resolutionKeys = Object.entries(options.updates || {})
      .filter(([, v]) => v !== "keep")
      .map(([k]) => k);
    if (resolutionKeys.length && !options.diffToken)
      throw new AppError("更新或新增冲突记录前必须重新对比", 409);
    for (const key of resolutionKeys) {
      const d = byKey.get(key),
        action = options.updates![key];
      if (
        !d ||
        !d.selected ||
        (action === "update"
          ? d.status !== "changed"
          : !["changed", "ambiguous"].includes(d.status))
      )
        throw new AppError("只能处理预览中已选中的变更或待核对记录", 409);
      if (action === "add") {
        const row = payload.rows.find((r) => r.key === key)!;
        if (!["new", "split"].includes(choices.get(groupKey(row))!.action))
          throw new AppError(
            "新增独立义项请先将本组导入方式选为新建或每行单独保存",
            409,
          );
      }
    }
    const snapshot = updateKeys.length
      ? snapshotBeforeChange(store)
      : undefined;
    let sourceId = scopedSource(store, options, payload)?.id;
    if (!sourceId)
      sourceId = store.createSource({
        id: randomUUID(),
        title: options.title,
        type: "Reading",
        allowSameName: options.separateSource === true,
        readingStatus:
          payload.scope ||
          payload.rows[0]?.data.importMetadata?.profile === "little-farm-v1"
            ? "reading"
            : "finished",
      }).id;
    const result: ImportResult = {
      ...(payload.scope
        ? {
            fileDuplicateContexts: payload.scope.fileDuplicateCount,
            skippedGroupContexts: groups
              .filter((g) => choices.get(g.key)!.action === "skip")
              .reduce((n, g) => n + g.rows.length, 0),
          }
        : {}),
      sourceId,
      createdExpressions: 0,
      importedContexts: 0,
      skippedContexts: 0,
      updatedContexts: 0,
      retainedChanges: 0,
      snapshot,
    };
    for (const group of groups) {
      const choice = choices.get(group.key)!;
      if (choice.action === "skip") continue;
      let expressionId =
        choice.action === "existing" ? choice.expressionId : undefined;
      if (choice.action === "existing") {
        const candidate = store
          .candidates(group.term)
          .find((e) => e.id === choice.expressionId);
        if (!candidate || candidate.lifecycle !== "active")
          throw new AppError(
            `“${group.term}”的目标义项不可用，请重新预览`,
            409,
          );
        if (!payload.scope && candidate.priority !== "P1")
          throw new AppError(
            `“${group.term}”的既有义项不是 P1；请新建或先调整等级`,
            409,
          );
      }
      for (const row of group.rows) {
        const diff = byKey.get(row.key)!;
        if (diff.status !== "new" && options.updates?.[row.key] !== "add") {
          if (
            diff.status === "changed" &&
            options.updates?.[row.key] === "update"
          ) {
            const old = store.context(diff.contextId!);
            const d = {
              ...old.data,
              sentence: row.data.sentence,
              chapter: row.data.chapter,
              page: row.data.page,
              meaning: importMeaning(row),
              ...(payload.scope ? { priority: row.data.priority } : {}),
              ...(row.data.importMetadata!.profile === "phrasebud-v1"
                ? { targetSurface: row.data.targetSurface }
                : {}),
              importMetadata: row.data.importMetadata,
            };
            store.updateContext(old.id, d, old.version, old.expressionId);
            store.db
              .prepare("UPDATE contexts SET data=? WHERE id=?")
              .run(JSON.stringify(d), old.id);
            result.updatedContexts!++;
          } else {
            result.skippedContexts++;
            if (diff.status === "changed") result.retainedChanges!++;
          }
          continue;
        }
        if (choice.action === "existing") {
          const candidate = store
            .candidates(group.term)
            .find((e) => e.id === choice.expressionId);
          if (
            !candidate ||
            candidate.lifecycle !== "active" ||
            (!payload.scope && candidate.priority !== "P1")
          )
            throw new AppError(
              `“${group.term}”的目标义项不可用${payload.scope ? "" : "或不是 P1"}，请重新预览`,
              409,
            );
          expressionId = choice.expressionId;
        } else if (!expressionId) expressionId = undefined;
        if (choice.action === "split") expressionId = undefined;
        const d = {
          ...row.data,
          sourceId,
          meaning: importMeaning(row),
          ...(row.data.importMetadata!.profile === "phrasebud-v1"
            ? { targetSurface: row.data.targetSurface }
            : {}),
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
          const priority =
            choice.action === "split"
              ? row.data.priority
              : group.rows.map((r) => r.data.priority).sort()[0];
          store.db
            .prepare("UPDATE expressions SET meaning=?,priority=? WHERE id=?")
            .run(group.meaning, priority, saved.expressionId!);
        }
        expressionId = saved.expressionId!;
        result.importedContexts++;
      }
    }
    return result;
  });
}
