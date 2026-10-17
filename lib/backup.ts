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
export const backupSchema = z
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
export type Backup = z.infer<typeof backupSchema>;
export const MAX_BACKUP = 50 * 1024 * 1024;
const tables = ["sources", "expressions", "contexts", "drafts"] as const;
export function exportBackup(store: Store): Backup {
  return store.transaction(() => {
    const rows = Object.fromEntries(
      tables.map((table) => [
        table,
        store
          .all(`SELECT * FROM ${table} ORDER BY id`)
          .map((row) =>
            row.data ? { ...row, data: JSON.parse(String(row.data)) } : row,
          ),
      ]),
    );
    return backupSchema.parse({
      format: "readwords-backup",
      schema_version: 2,
      exported_at: new Date().toISOString(),
      ...rows,
    });
  });
}
function invalid(message: string): never {
  throw new AppError(`备份无效：${message}`);
}
export function validateBackup(input: unknown): Backup {
  const b = backupSchema.parse(input);
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
  return b;
}
export function counts(b: Backup) {
  return {
    sources: b.sources.length,
    expressions: b.expressions.length,
    contexts: b.contexts.length,
    drafts: b.drafts.length,
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
      "DELETE FROM drafts; DELETE FROM contexts; DELETE FROM expressions; DELETE FROM sources;",
    );
    for (const table of tables)
      for (const row of p.data[table]) {
        const record: Record<string, unknown> = { ...row };
        if ("data" in record) record.data = JSON.stringify(record.data);
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
