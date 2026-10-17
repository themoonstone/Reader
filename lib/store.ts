import {
  createReviewTables,
  restartReview,
  reconcileReview,
} from "./review-storage";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import {
  draftSchema,
  expressionSchema,
  validateContext,
  sourceSchema,
  normalize,
  type Draft,
  type DraftInput,
  type Source,
  type Expression,
  type Context,
} from "./contracts";

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "INVALID_INPUT",
  ) {
    super(message);
  }
}
type Row = Record<string, string | number | null>;
const now = () => new Date().toISOString();
export class Store {
  db: DatabaseSync;
  private transactionDepth = 0;
  readonly snapshotDir: string;
  private reviewReady = false;
  constructor(
    readonly path: string,
    readonly clock: () => number = Date.now,
  ) {
    this.snapshotDir =
      path === ":memory:"
        ? resolve("/tmp/readwords-memory-snapshots", randomUUID())
        : resolve(dirname(resolve(path)), "snapshots", basename(path));
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
      );
      const version = Number(
        (this.db.prepare("PRAGMA user_version").get() as Row).user_version,
      );
      if (version > 3)
        throw new AppError("数据库版本高于当前程序，请使用更新版本", 500);
      if (version === 0)
        this.transaction(() =>
          this.db.exec(`
      CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE expressions (id TEXT PRIMARY KEY, term TEXT NOT NULL, normalized_term TEXT NOT NULL, meaning TEXT NOT NULL,
        type TEXT NOT NULL, priority TEXT NOT NULL, alternative TEXT NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX expressions_normalized ON expressions(normalized_term);
      CREATE TABLE drafts (id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id), data TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', version INTEGER NOT NULL DEFAULT 1,
        expression_id TEXT REFERENCES expressions(id), context_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, expression_id TEXT NOT NULL REFERENCES expressions(id),
        source_id TEXT NOT NULL REFERENCES sources(id), event_kind TEXT NOT NULL, data TEXT NOT NULL,
        fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX contexts_expression ON contexts(expression_id);
      CREATE INDEX contexts_source ON contexts(source_id);
      PRAGMA user_version=1;
    `),
        );
      if (version === 1) {
        // VACUUM INTO is a consistent SQLite snapshot even when the source uses WAL.
        mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
        const snapshot = join(
          this.snapshotDir,
          `before-schema-v2-${randomUUID()}.sqlite`,
        );
        this.db.prepare("VACUUM INTO ?").run(snapshot);
        chmodSync(snapshot, 0o600);
        for (const target of [snapshot, this.snapshotDir]) {
          const fd = openSync(target, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        }
      }
      if (version < 2)
        this.transaction(() =>
          this.db.exec(`
      ALTER TABLE contexts ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';
      ALTER TABLE contexts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE contexts ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE contexts ADD COLUMN deleted_by TEXT;
      UPDATE contexts SET updated_at=created_at;
      ALTER TABLE expressions ADD COLUMN restore_lifecycle TEXT NOT NULL DEFAULT 'active';
      CREATE TABLE workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO workspace_meta VALUES('generation','${randomUUID()}');
      PRAGMA user_version=2;
    `),
        );
      if (version < 3) {
        if (version > 0) this.snapshotUpgrade(3);
        this.transaction(() => createReviewTables(this.db));
      }
      this.reviewReady = true;
      this.transaction(() =>
        restartReview(this.db, new Date(this.clock()).toISOString()),
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private snapshotUpgrade(version: number) {
    mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 });
    const path = join(
      this.snapshotDir,
      `before-schema-v${version}-${randomUUID()}.sqlite`,
    );
    this.db.prepare("VACUUM INTO ?").run(path);
    chmodSync(path, 0o600);
    for (const target of [path, this.snapshotDir]) {
      const fd = openSync(target, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  get generation() {
    return String(
      this.one("SELECT value FROM workspace_meta WHERE key='generation'")!
        .value,
    );
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    const depth = this.transactionDepth++;
    const savepoint = `rw_${depth}`;
    try {
      this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      const result = fn();
      if (depth === 0 && this.reviewReady)
        reconcileReview(this.db, new Date(this.clock()).toISOString());
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (e) {
      if (this.db.isTransaction)
        this.db.exec(
          depth === 0
            ? "ROLLBACK"
            : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
        );
      throw e;
    } finally {
      this.transactionDepth--;
    }
  }
  one(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  all(sql: string, ...params: (string | number | null)[]) {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  getSource(id: string): Source {
    const row = this.one("SELECT * FROM sources WHERE id=?", id);
    if (!row) throw new AppError("来源不存在", 404, "NOT_FOUND");
    return {
      ...JSON.parse(String(row.data)),
      id: String(row.id),
      lifecycle: String(row.lifecycle),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      expressionCount: Number(
        this.one(
          "SELECT COUNT(DISTINCT c.expression_id) AS n FROM contexts c JOIN expressions e ON e.id=c.expression_id WHERE c.source_id=? AND c.lifecycle='active' AND e.lifecycle!='deleted'",
          id,
        )!.n,
      ),
    };
  }
  sources() {
    return this.all("SELECT id FROM sources ORDER BY updated_at DESC,id").map(
      (r) => this.getSource(String(r.id)),
    );
  }
  createSource(input: unknown) {
    const data = sourceSchema.parse(input);
    const old = this.one("SELECT id FROM sources WHERE id=?", data.id);
    if (old) return this.getSource(data.id);
    const time = now();
    this.db
      .prepare(
        "INSERT INTO sources(id,type,title,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(data.id, data.type, data.title, JSON.stringify(data), time, time);
    return this.getSource(data.id);
  }
  updateSource(
    id: string,
    input: unknown,
    version: number,
    lifecycle?: string,
  ) {
    return this.transaction(() => {
      const old = this.getSource(id);
      this.checkVersion(old.version, version);
      const data = sourceSchema.parse({ ...(input as object), id });
      if (data.type !== old.type)
        throw new AppError("来源类型不可修改，请新建来源");
      if (lifecycle && !["active", "archived"].includes(lifecycle))
        throw new AppError("来源状态无效");
      this.db
        .prepare(
          "UPDATE sources SET title=?,data=?,lifecycle=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          data.title,
          JSON.stringify(data),
          lifecycle ?? old.lifecycle,
          now(),
          id,
        );
      return this.getSource(id);
    });
  }
  private checkVersion(actual: number, expected: number) {
    if (actual !== expected)
      throw new AppError(
        "内容已在其他窗口修改。请复制当前输入，重新打开后再保存。",
        409,
        "VERSION_CONFLICT",
      );
  }
  private checkSource(data: DraftInput, required = false) {
    if (!data.sourceId) {
      if (required) throw new AppError("请选择来源");
      return;
    }
    const s = this.getSource(data.sourceId);
    if (s.lifecycle !== "active" || s.type !== data.sourceType)
      throw new AppError("来源类型不匹配或已归档，请重新选择");
  }
  getDraft(id: string): Draft {
    const r = this.one("SELECT * FROM drafts WHERE id=?", id);
    if (!r) throw new AppError("草稿不存在", 404, "NOT_FOUND");
    return {
      id: String(r.id),
      version: Number(r.version),
      state: r.state as Draft["state"],
      data: JSON.parse(String(r.data)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      expressionId: r.expression_id as string | null,
    };
  }
  drafts() {
    return this.all(
      "SELECT id FROM drafts WHERE state!='saved' ORDER BY created_at DESC,id",
    ).map((r) => this.getDraft(String(r.id)));
  }
  createDraft(id: string, input: unknown) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new AppError("采集标识无效");
    if (this.one("SELECT id FROM drafts WHERE id=?", id))
      return this.getDraft(id);
    const data = draftSchema.parse(input);
    this.checkSource(data);
    const time = now();
    this.db
      .prepare(
        "INSERT INTO drafts(id,source_id,data,created_at,updated_at) VALUES(?,?,?,?,?)",
      )
      .run(id, data.sourceId || null, JSON.stringify(data), time, time);
    return this.getDraft(id);
  }
  updateDraft(id: string, input: unknown, version: number, state?: string) {
    return this.transaction(() => {
      const old = this.getDraft(id);
      this.checkVersion(old.version, version);
      if (old.state === "saved") throw new AppError("此草稿已经入库", 409);
      const data = draftSchema.parse(input);
      this.checkSource(data);
      if (state && !["pending", "ignored"].includes(state))
        throw new AppError("草稿状态无效");
      this.db
        .prepare(
          "UPDATE drafts SET data=?,source_id=?,state=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(data),
          data.sourceId || null,
          state ?? old.state,
          now(),
          id,
        );
      return this.getDraft(id);
    });
  }
  private fingerprint(data: DraftInput) {
    return JSON.stringify([
      data.sourceId,
      data.sentence,
      data.correctedSentence,
      data.chapter,
      data.page,
      data.timestampSeconds,
      data.eventKind,
    ]);
  }
  saveDraft(
    id: string,
    options: {
      version: number;
      expressionId?: string;
      newSense?: boolean;
      allowDuplicate?: boolean;
    },
  ) {
    return this.transaction(() => {
      const draft = this.getDraft(id);
      if (draft.state === "saved")
        return { expressionId: draft.expressionId, replay: true };
      this.checkVersion(draft.version, options.version);
      if (draft.state !== "pending") throw new AppError("请先恢复这条草稿");
      this.checkSource(draft.data, true);
      let d: DraftInput;
      try {
        d = validateContext(draft.data, this.getSource(draft.data.sourceId));
      } catch (e) {
        throw new AppError((e as Error).message);
      }
      const candidates = this.candidates(d.term);
      let expressionId = options.expressionId;
      if (expressionId) {
        if (!candidates.some((e) => e.id === expressionId))
          throw new AppError("请选择此表达的有效义项");
      } else if (candidates.length && !options.newSense)
        throw new AppError(
          "发现相同表达，请明确选择已有义项或新建义项",
          409,
          "CHOOSE_SENSE",
        );
      const fingerprint = this.fingerprint(d);
      if (
        !options.allowDuplicate &&
        expressionId &&
        this.one(
          "SELECT id FROM contexts WHERE expression_id=? AND fingerprint=? AND lifecycle='active'",
          expressionId,
          fingerprint,
        )
      )
        throw new AppError(
          "可能是重复接触记录，请确认这是另一次事件",
          409,
          "DUPLICATE_CONTEXT",
        );
      const time = now();
      if (!expressionId) {
        expressionId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO expressions(id,term,normalized_term,meaning,type,priority,alternative,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            expressionId,
            d.term,
            normalize(d.term),
            d.meaning,
            d.expressionType,
            d.priority,
            d.alternative,
            time,
            time,
          );
      } else
        this.db
          .prepare(
            "UPDATE expressions SET updated_at=?,version=version+1 WHERE id=?",
          )
          .run(time, expressionId);
      const contextId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO contexts(id,expression_id,source_id,event_kind,data,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          contextId,
          expressionId,
          d.sourceId,
          d.eventKind,
          JSON.stringify(d),
          fingerprint,
          time,
          time,
        );
      this.db
        .prepare(
          "UPDATE drafts SET state='saved',expression_id=?,context_id=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(expressionId, contextId, time, id);
      this.db
        .prepare("UPDATE sources SET updated_at=? WHERE id=?")
        .run(time, d.sourceId);
      return { expressionId, replay: false };
    });
  }
  expression(id: string): Expression {
    const r = this.one("SELECT * FROM expressions WHERE id=?", id);
    if (!r) throw new AppError("表达不存在", 404, "NOT_FOUND");
    const allContexts: Context[] = this.all(
      "SELECT c.*,s.title AS source_title,s.type AS source_type FROM contexts c JOIN sources s ON s.id=c.source_id WHERE expression_id=? ORDER BY c.created_at DESC,c.id",
      id,
    ).map((c) => ({
      id: String(c.id),
      expressionId: String(c.expression_id),
      version: Number(c.version),
      lifecycle: String(c.lifecycle),
      sourceId: String(c.source_id),
      sourceTitle: String(c.source_title),
      sourceType: String(c.source_type),
      data: JSON.parse(String(c.data)),
      createdAt: String(c.created_at),
    }));
    const contexts = allContexts.filter((c) => c.lifecycle === "active");
    return {
      id,
      version: Number(r.version),
      term: String(r.term),
      meaning: String(r.meaning),
      type: String(r.type),
      priority: String(r.priority),
      lifecycle: String(r.lifecycle),
      alternative: String(r.alternative),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      seen: contexts.filter((c) => c.data.eventKind === "exposure").length,
      used: contexts.filter((c) => c.data.eventKind === "output_used").length,
      contextCount: contexts.length,
      sourceCount: new Set(contexts.map((c) => c.sourceId)).size,
      contexts,
      deletedContexts: allContexts.filter((c) => c.lifecycle === "deleted"),
    };
  }
  updateExpression(
    id: string,
    input: unknown,
    version: number,
    lifecycle?: string,
  ) {
    return this.transaction(() => {
      const old = this.expression(id);
      this.checkVersion(old.version, version);
      if (old.lifecycle === "deleted")
        throw new AppError("请从回收站恢复表达后编辑");
      const d = expressionSchema.parse(input);
      if (lifecycle && !["active", "archived"].includes(lifecycle))
        throw new AppError("表达状态无效");
      this.db
        .prepare(
          "UPDATE expressions SET term=?,normalized_term=?,meaning=?,type=?,priority=?,alternative=?,lifecycle=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          d.term,
          normalize(d.term),
          d.meaning,
          d.type,
          d.priority,
          d.alternative,
          lifecycle ?? old.lifecycle,
          now(),
          id,
        );
      return this.expression(id);
    });
  }
  deleteExpression(id: string, version: number) {
    return this.transaction(() => {
      const old = this.expression(id);
      this.checkVersion(old.version, version);
      if (old.lifecycle === "deleted") throw new AppError("表达已在回收站");
      this.db
        .prepare(
          "UPDATE expressions SET restore_lifecycle=lifecycle,lifecycle='deleted',version=version+1,updated_at=? WHERE id=?",
        )
        .run(now(), id);
      this.db
        .prepare(
          "UPDATE contexts SET lifecycle='deleted',deleted_by=?,version=version+1,updated_at=? WHERE expression_id=? AND lifecycle='active'",
        )
        .run(id, now(), id);
      return { ok: true };
    });
  }
  restoreExpression(id: string, version: number) {
    return this.transaction(() => {
      const old = this.expression(id);
      this.checkVersion(old.version, version);
      if (old.lifecycle !== "deleted") throw new AppError("表达不在回收站");
      this.db
        .prepare(
          "UPDATE expressions SET lifecycle=restore_lifecycle,version=version+1,updated_at=? WHERE id=?",
        )
        .run(now(), id);
      this.db
        .prepare(
          "UPDATE contexts SET lifecycle='active',deleted_by=NULL,version=version+1,updated_at=? WHERE expression_id=? AND deleted_by=?",
        )
        .run(now(), id, id);
      return this.expression(id);
    });
  }
  trash() {
    return this.all(
      "SELECT id FROM expressions WHERE lifecycle='deleted' ORDER BY updated_at DESC",
    ).map((r) => this.expression(String(r.id)));
  }
  context(id: string) {
    const row = this.one("SELECT expression_id FROM contexts WHERE id=?", id);
    if (!row) throw new AppError("语境不存在", 404);
    const e = this.expression(String(row.expression_id));
    return [...e.contexts, ...e.deletedContexts].find((c) => c.id === id)!;
  }
  updateContext(
    id: string,
    input: unknown,
    version: number,
    targetId: string,
    allowDuplicate = false,
  ) {
    return this.transaction(() => {
      const old = this.context(id);
      this.checkVersion(old.version, version);
      if (
        old.lifecycle !== "active" ||
        this.expression(old.expressionId).lifecycle === "deleted"
      )
        throw new AppError("请先恢复表达和语境");
      const target = this.expression(targetId);
      if (target.lifecycle === "deleted") throw new AppError("目标表达已删除");
      const raw = draftSchema.parse(input);
      const source = this.getSource(raw.sourceId);
      if (source.lifecycle !== "active" && source.id !== old.sourceId)
        throw new AppError("新增归属前请先恢复来源");
      let d: DraftInput;
      try {
        d = validateContext(
          { ...raw, importMetadata: old.data.importMetadata },
          source,
        );
      } catch (e) {
        throw new AppError((e as Error).message);
      }
      const fingerprint = this.fingerprint(d);
      if (
        !allowDuplicate &&
        this.one(
          "SELECT id FROM contexts WHERE id!=? AND expression_id=? AND fingerprint=? AND lifecycle='active'",
          id,
          targetId,
          fingerprint,
        )
      )
        throw new AppError(
          "目标表达中已有相同事件，请确认是另一次记录",
          409,
          "DUPLICATE_CONTEXT",
        );
      this.db
        .prepare(
          "UPDATE contexts SET expression_id=?,source_id=?,event_kind=?,data=?,fingerprint=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          targetId,
          d.sourceId,
          d.eventKind,
          JSON.stringify(d),
          fingerprint,
          now(),
          id,
        );
      for (const eid of new Set([old.expressionId, targetId]))
        this.db
          .prepare(
            "UPDATE expressions SET version=version+1,updated_at=? WHERE id=?",
          )
          .run(now(), eid);
      return this.context(id);
    });
  }
  setContextDeleted(id: string, version: number, deleted: boolean) {
    return this.transaction(() => {
      const old = this.context(id);
      this.checkVersion(old.version, version);
      if (this.expression(old.expressionId).lifecycle === "deleted")
        throw new AppError("请先恢复表达");
      if (old.lifecycle !== (deleted ? "active" : "deleted"))
        throw new AppError("语境状态已变化，请刷新");
      this.db
        .prepare(
          "UPDATE contexts SET lifecycle=?,deleted_by=NULL,version=version+1,updated_at=? WHERE id=?",
        )
        .run(deleted ? "deleted" : "active", now(), id);
      this.db
        .prepare(
          "UPDATE expressions SET version=version+1,updated_at=? WHERE id=?",
        )
        .run(now(), old.expressionId);
      return this.context(id);
    });
  }
  candidates(term: string) {
    return this.all(
      "SELECT id FROM expressions WHERE normalized_term=? AND lifecycle!='deleted' ORDER BY created_at,id",
      normalize(term),
    ).map((r) => this.expression(String(r.id)));
  }
  search(
    query = "",
    type = "",
    priority = "",
    includeArchived = false,
    sourceId = "",
  ) {
    const q = normalize(query);
    return this.all(
      "SELECT id FROM expressions WHERE lifecycle='active' OR (?=1 AND lifecycle='archived')",
      includeArchived ? 1 : 0,
    )
      .map((r) => this.expression(String(r.id)))
      .filter((e) => !priority || e.priority === priority)
      .filter(
        (e) =>
          (!type && !sourceId) ||
          e.contexts.some(
            (c) =>
              (!type || c.sourceType === type) &&
              (!sourceId || c.sourceId === sourceId),
          ),
      )
      .map((e) => {
        const matches: string[] = [];
        if (normalize(e.term).includes(q)) matches.push("表达");
        if (normalize(e.meaning).includes(q)) matches.push("义项");
        for (const c of e.contexts) {
          if (
            [
              c.data.meaning,
              c.data.sentence,
              c.data.correctedSentence,
              c.sourceTitle,
            ].some((v) => normalize(v).includes(q))
          )
            matches.push(c.sourceTitle);
        }
        return { ...e, matches: [...new Set(matches)] };
      })
      .filter((e) => !q || e.matches.length > 0)
      .sort((a, b) => {
        const rank = (e: Expression) =>
          !q
            ? 0
            : normalize(e.term) === q
              ? 0
              : normalize(e.term).startsWith(q)
                ? 1
                : normalize(e.term).includes(q)
                  ? 2
                  : 3;
        return (
          rank(a) - rank(b) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.id.localeCompare(b.id)
        );
      });
  }
}
const globalStore = globalThis as unknown as { readwordsStore?: Store };
export function getStore() {
  // Refresh the connection/service after a development hot reload; otherwise a
  // cached instance can retain obsolete transaction logic from an earlier build.
  if (
    globalStore.readwordsStore &&
    !(globalStore.readwordsStore instanceof Store)
  ) {
    (globalStore.readwordsStore as Store).close();
    globalStore.readwordsStore = undefined;
  }
  return (globalStore.readwordsStore ??= new Store(
    process.env.READWORDS_DB_PATH ||
      resolve(process.cwd(), "data/readwords.sqlite"),
  ));
}
