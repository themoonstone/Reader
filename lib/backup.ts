import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { AppError, type Store } from "./store";
import {
  draftSchema,
  sourceSchema,
  expressionSchema,
  normalize,
  validateContext,
} from "./contracts";

import {
  reviewEntrySchema,
  reviewSessionSchema,
  reviewCardSchema,
  reviewRecordSchema,
  reviewInterval,
} from "./review-contracts";
import { reviewTables, recognitionSentence } from "./review-storage";
const stamp = z.iso.datetime();
const id = z.uuid();
const version = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 100);
const source = z
  .object({
    id,
    type: z.enum(["Reading", "Listening", "Writing", "Manual"]),
    title: z.string(),
    data: sourceSchema.strict(),
    lifecycle: z.enum(["active", "archived"]),
    version,
    created_at: stamp,
    updated_at: stamp,
  })
  .strict();
const expression = expressionSchema
  .extend({
    id,
    normalized_term: z.string(),
    lifecycle: z.enum(["active", "archived", "deleted"]),
    restore_lifecycle: z.enum(["active", "archived"]),
    version,
    created_at: stamp,
    updated_at: stamp,
  })
  .strict();
const context = z
  .object({
    id,
    expression_id: id,
    source_id: id,
    event_kind: z.string(),
    data: draftSchema.strict(),
    fingerprint: z.string(),
    lifecycle: z.enum(["active", "deleted"]),
    version,
    created_at: stamp,
    updated_at: stamp,
    deleted_by: id.nullable(),
  })
  .strict();
const draft = z
  .object({
    id,
    source_id: id.nullable(),
    data: draftSchema.strict(),
    state: z.enum(["pending", "ignored", "saved"]),
    version,
    expression_id: id.nullable(),
    context_id: id.nullable(),
    created_at: stamp,
    updated_at: stamp,
  })
  .strict();
const legacyBackupSchema = z
  .object({
    format: z.literal("readwords-backup"),
    schema_version: z.literal(2),
    exported_at: stamp,
    sources: z.array(source).max(100000),
    expressions: z.array(expression).max(100000),
    contexts: z.array(context).max(500000),
    drafts: z.array(draft).max(500000),
  })
  .strict();
export const backupSchema = legacyBackupSchema
  .extend({
    schema_version: z.literal(3),
    review_entries: z.array(reviewEntrySchema).max(100000),
    review_sessions: z.array(reviewSessionSchema).max(500000),
    review_cards: z.array(reviewCardSchema).max(500000),
    review_records: z.array(reviewRecordSchema).max(500000),
  })
  .strict();
export type Backup = z.infer<typeof backupSchema>;
export const MAX_BACKUP = 50 * 1024 * 1024;
const tables = [
  "sources",
  "expressions",
  "contexts",
  "drafts",
  ...reviewTables,
] as const;
export function exportBackup(store: Store): Backup {
  return store.transaction(() => {
    const rows = Object.fromEntries(
      tables.map((table) => [
        table,
        store
          .all(`SELECT * FROM ${table} ORDER BY id`)
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                ["data", "snapshot", "policy"].includes(k)
                  ? JSON.parse(String(v))
                  : v,
              ]),
            ),
          ),
      ]),
    );
    return backupSchema.parse({
      format: "readwords-backup",
      schema_version: 3,
      exported_at: new Date().toISOString(),
      ...rows,
    });
  });
}
function invalid(message: string): never {
  throw new AppError(`备份无效：${message}`);
}
export function validateBackup(input: unknown): Backup {
  const parsed = z.union([backupSchema, legacyBackupSchema]).parse(input);
  const b = backupSchema.parse(
    parsed.schema_version === 2
      ? {
          ...parsed,
          schema_version: 3,
          review_entries: [],
          review_sessions: [],
          review_cards: [],
          review_records: [],
        }
      : parsed,
  );
  const indexed = <T extends { id: string }>(rows: T[]) => {
    const m = new Map(rows.map((r) => [r.id, r]));
    if (m.size !== rows.length) invalid("重复 ID");
    return m;
  };
  const ss = indexed(b.sources),
    es = indexed(b.expressions),
    cs = indexed(b.contexts);
  indexed(b.drafts);
  for (const rows of [b.sources, b.expressions, b.contexts, b.drafts])
    for (const row of rows)
      if (row.updated_at < row.created_at) invalid("更新时间早于创建时间");
  for (const s of b.sources)
    if (
      s.data.id !== s.id ||
      s.data.title !== s.title ||
      s.data.type !== s.type
    )
      invalid("来源字段不一致");
  for (const e of b.expressions)
    if (normalize(e.term) !== e.normalized_term) invalid("表达规范形式不一致");
  for (const c of b.contexts) {
    const s = ss.get(c.source_id),
      e = es.get(c.expression_id);
    if (!s || !e) invalid("语境引用不存在");
    let d;
    try {
      // A source duration may have been corrected since a historical encounter.
      d = validateContext(c.data, { ...s.data, duration: "" });
    } catch {
      invalid("语境字段或时间无效");
    }
    if (
      c.data.sourceId !== c.source_id ||
      c.data.eventKind !== c.event_kind ||
      d.timestampSeconds !== c.data.timestampSeconds
    )
      invalid("语境关联或时间不一致");
    const fingerprint = JSON.stringify([
      d.sourceId,
      d.sentence,
      d.correctedSentence,
      d.chapter,
      d.page,
      d.timestampSeconds,
      d.eventKind,
    ]);
    if (c.fingerprint !== fingerprint) invalid("事件指纹不一致");
    if (e.lifecycle === "deleted" && c.lifecycle !== "deleted")
      invalid("删除表达包含有效语境");
    if (
      c.deleted_by &&
      (c.deleted_by !== e.id ||
        e.lifecycle !== "deleted" ||
        c.lifecycle !== "deleted")
    )
      invalid("级联删除标记无效");
  }
  for (const d of b.drafts) {
    if ((d.data.sourceId || null) !== d.source_id) invalid("草稿来源不一致");
    if (
      d.source_id &&
      (!ss.has(d.source_id) || ss.get(d.source_id)!.type !== d.data.sourceType)
    )
      invalid("草稿来源无效");
    if (d.state === "saved") {
      if (
        !d.expression_id ||
        !es.has(d.expression_id) ||
        !d.context_id ||
        !cs.has(d.context_id)
      )
        invalid("已保存草稿结果丢失");
    } else if (d.expression_id !== null || d.context_id !== null)
      invalid("待处理草稿含入库结果");
  }
  validateReview(b);
  return b;
}
function validateReview(b: Backup) {
  const map = <T extends { id: string }>(rows: T[]) => {
    const m = new Map(rows.map((r) => [r.id, r]));
    if (m.size !== rows.length) invalid("复习 ID 重复");
    return m;
  };
  const entries = map(b.review_entries),
    sessions = map(b.review_sessions),
    cards = map(b.review_cards);
  map(b.review_records);
  const es = map(b.expressions),
    cs = map(b.contexts);
  const unique = (values: string[]) => {
    if (new Set(values).size !== values.length) invalid("复习唯一键重复");
  };
  unique(b.review_entries.map((e) => e.expression_id));
  unique(b.review_sessions.map((s) => s.start_request_id));
  unique(b.review_cards.map((c) => c.issue_request_id));
  unique(b.review_cards.map((c) => c.session_id + ":" + c.expression_id));
  unique(b.review_records.map((r) => r.card_id));
  if (
    b.review_entries.filter((e) => e.state === "active").length > 20 ||
    b.review_sessions.filter((s) => s.state !== "ended").length > 1
  )
    invalid("复习容量或未结束会话超限");
  for (const e of entries.values()) {
    const x = es.get(e.expression_id);
    if (!x) invalid("复习表达引用丢失");
    if (e.updated_at < e.created_at) invalid("复习池时间无效");
    if (
      Boolean(e.first_presented_at) !== Boolean(e.first_presented_local_date) ||
      Boolean(e.first_presented_at) !== Boolean(e.first_presented_timezone) ||
      Boolean(e.first_presented_at) !== Boolean(e.last_presented_at)
    )
      invalid("首次展示字段不一致");
    if (
      e.state === "active" &&
      (x.lifecycle !== "active" ||
        !["P1", "P2"].includes(x.priority) ||
        !x.meaning ||
        !b.contexts.some(
          (c) =>
            c.expression_id === x.id &&
            c.lifecycle === "active" &&
            c.data.meaning &&
            recognitionSentence(c.data),
        ))
    )
      invalid("活跃复习池材料无效");
  }
  const dates = new Map<string, number>();
  for (const c of cards.values()) {
    const e = entries.get(c.entry_id),
      s = sessions.get(c.session_id);
    if (
      !e ||
      !s ||
      e.expression_id !== c.expression_id ||
      !es.has(c.expression_id) ||
      !cs.has(c.context_id)
    )
      invalid("复习卡片引用无效");
    if (
      c.created_at < s.started_at ||
      (c.revealed_at && c.revealed_at < c.created_at)
    )
      invalid("卡片时间无效");
    try {
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone: c.presented_timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(c.created_at));
      if (date !== c.presented_local_date) invalid("展示日期与时区/时间不一致");
    } catch {
      invalid("展示日期或时区无效");
    }
    if (["revealed", "answered"].includes(c.state) && !c.revealed_at)
      invalid("缺少揭晓时间");
    if (c.is_first_presentation) {
      dates.set(
        c.presented_local_date,
        (dates.get(c.presented_local_date) || 0) + 1,
      );
      if (
        e.first_presented_at !== c.created_at ||
        e.first_presented_local_date !== c.presented_local_date ||
        e.first_presented_timezone !== c.presented_timezone
      )
        invalid("首次展示不一致");
    }
  }
  if ([...dates.values()].some((n) => n > 5)) invalid("当日首次引入超限");
  for (const e of entries.values())
    if (
      b.review_cards.filter(
        (c) => c.entry_id === e.id && c.is_first_presentation,
      ).length !== Number(Boolean(e.first_presented_at))
    )
      invalid("首次引入卡不一致");
  for (const s of sessions.values()) {
    const rows = b.review_cards.filter((c) => c.session_id === s.id);
    if (
      s.issued_count !== rows.length ||
      s.issued_count > s.card_limit ||
      s.introduced_count !==
        rows.filter((c) => c.is_first_presentation).length ||
      s.introduced_count > s.new_limit ||
      s.active_elapsed_ms > s.budget_seconds * 1000
    )
      invalid("会话计数无效");
    if (
      (s.state === "ended") !== Boolean(s.ended_at) ||
      (s.state === "ended") !== Boolean(s.end_reason) ||
      s.last_checkpoint_at < s.started_at ||
      (s.ended_at && s.ended_at < s.started_at)
    )
      invalid("会话结束状态无效");
    if (s.current_card_id && cards.get(s.current_card_id)?.session_id !== s.id)
      invalid("当前卡引用无效");
    if (
      rows.length > 0 !== Boolean(s.current_card_id) ||
      rows
        .filter((c) => ["shown", "revealed"].includes(c.state))
        .some((c) => c.id !== s.current_card_id)
    )
      invalid("当前卡状态无效");
  }
  const recorded = new Set<string>();
  for (const r of b.review_records) {
    const c = cards.get(r.card_id);
    if (
      !c ||
      c.state !== "answered" ||
      c.session_id !== r.session_id ||
      c.entry_id !== r.entry_id ||
      c.expression_id !== r.original_expression_id ||
      c.context_id !== r.context_id ||
      JSON.stringify(c.snapshot) !== JSON.stringify(r.snapshot) ||
      r.reviewed_at < (c.revealed_at || c.created_at)
    )
      invalid("反馈引用或快照无效");
    const next = reviewInterval(
      r.old_stage,
      r.result,
      Date.parse(r.reviewed_at),
    );
    if (
      next.stage !== r.new_stage ||
      next.eligibleAfter !== r.new_eligible_after
    )
      invalid("反馈间隔无效");
    recorded.add(c.id);
  }
  for (const c of cards.values())
    if ((c.state === "answered") !== recorded.has(c.id))
      invalid("卡片与反馈不一致");
}
export function counts(b: Backup) {
  return {
    sources: b.sources.length,
    expressions: b.expressions.length,
    contexts: b.contexts.length,
    drafts: b.drafts.length,
    review_entries: b.review_entries.length,
    review_sessions: b.review_sessions.length,
    review_cards: b.review_cards.length,
    review_records: b.review_records.length,
  };
}
function digest(b: Backup) {
  return createHash("sha256")
    .update(JSON.stringify({ ...b, exported_at: "" }))
    .digest("hex");
}
function snapshot(store: Store, b: Backup) {
  mkdirSync(store.snapshotDir, { recursive: true, mode: 0o700 });
  const name = `before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.json`;
  const file = join(store.snapshotDir, name);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(b));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Ensure the directory entry survives a crash before advertising the snapshot.
  const dir = openSync(store.snapshotDir, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
  return name;
}
type Preview = {
  data: Backup;
  digest: string;
  generation: string;
  expires: number;
  snapshot: string;
  store: Store;
};
const previews = new Map<string, Preview>();
export function previewRestore(store: Store, input: unknown) {
  const b = validateBackup(input);
  const bytes = Buffer.byteLength(JSON.stringify(b));
  if (bytes > MAX_BACKUP) throw new AppError("备份文件不能超过 50 MB", 413);
  for (const [key, p] of previews)
    if (p.expires < Date.now()) previews.delete(key);
  if (previews.size >= 3) previews.delete(previews.keys().next().value!);
  return store.transaction(() => {
    const current = exportBackup(store);
    if (Buffer.byteLength(JSON.stringify(current)) > MAX_BACKUP)
      throw new AppError(
        "当前学习库超过 50 MB 恢复限制，无法生成可恢复快照；请先保留数据库并联系维护者。",
      );
    const space = statfsSync(
      store.path === ":memory:" ? "/tmp" : dirname(resolve(store.path)),
    );
    if (
      space.bavail * space.bsize <
      3 * (bytes + Buffer.byteLength(JSON.stringify(current)))
    )
      throw new AppError("可用磁盘空间不足，未替换数据库");
    const name = snapshot(store, current),
      token = randomUUID();
    previews.set(token, {
      data: b,
      digest: digest(current),
      generation: store.generation,
      expires: Date.now() + 10 * 60 * 1000,
      snapshot: name,
      store,
    });
    return {
      token,
      warning:
        (input as { schema_version?: number })?.schema_version === 2
          ? "这是 schema 2 旧备份，不含复习数据；确认替换会清除当前全部复习池、会话和反馈进度。"
          : "",
      incoming: counts(b),
      current: counts(current),
      snapshot: name,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  });
}
export function commitRestore(store: Store, token: string, confirmed: boolean) {
  if (!confirmed) throw new AppError("请明确确认替换当前学习库");
  const p = previews.get(token);
  if (!p || p.store !== store || p.expires < Date.now())
    throw new AppError("恢复预览已失效，请重新选择备份文件", 409);
  const result = store.transaction(() => {
    if (
      p.generation !== store.generation ||
      p.digest !== digest(exportBackup(store))
    )
      throw new AppError("预览后数据已有变化，请重新预览并生成快照", 409);
    // A deleted/corrupted preview snapshot must never authorize replacement.
    if (digest(readSnapshot(store, p.snapshot)) !== p.digest)
      throw new AppError("恢复前快照已变化，请重新预览", 409);
    store.db.exec(
      "DELETE FROM review_leases; DELETE FROM review_records; DELETE FROM review_cards; DELETE FROM review_sessions; DELETE FROM review_entries; DELETE FROM drafts; DELETE FROM contexts; DELETE FROM expressions; DELETE FROM sources;",
    );
    for (const table of tables)
      for (const row of p.data[table]) {
        const record: Record<string, unknown> = { ...row };
        for (const key of ["data", "snapshot", "policy"])
          if (key in record) record[key] = JSON.stringify(record[key]);
        if (table === "review_sessions" && record.state === "running") {
          record.state = "paused";
          record.version = Number(record.version) + 1;
        }
        const keys = Object.keys(record);
        store.db
          .prepare(
            `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          )
          .run(...keys.map((k) => record[k] as string | number | null));
      }
    if (store.all("PRAGMA foreign_key_check").length)
      throw new AppError("恢复后的引用检查失败");
    store.db
      .prepare("UPDATE workspace_meta SET value=? WHERE key='generation'")
      .run(randomUUID());
    return { ok: true, snapshot: p.snapshot, counts: counts(p.data) };
  });
  previews.delete(token);
  return result;
}
export function snapshots(store: Store) {
  mkdirSync(store.snapshotDir, { recursive: true, mode: 0o700 });
  return readdirSync(store.snapshotDir)
    .filter((n) => /^before-restore-[\w-]+\.json$/.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name }));
}
export function readSnapshot(store: Store, name: string) {
  if (!snapshots(store).some((s) => s.name === name))
    throw new AppError("快照不存在", 404);
  return validateBackup(
    JSON.parse(readFileSync(join(store.snapshotDir, name), "utf8")),
  );
}
