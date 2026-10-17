import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  draftSchema,
  sourceSchema,
  normalize,
  validDate,
  parseTimestamp,
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
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row).user_version,
    );
    if (version > 1)
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
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
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
          "SELECT COUNT(DISTINCT expression_id) AS n FROM contexts WHERE source_id=?",
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
      const d = draftSchema.parse(draft.data);
      this.checkSource(d, true);
      if (!d.meaning) throw new AppError("请填写语境释义");
      if (d.whySaved === "other" && !d.note)
        throw new AppError("选择其他原因时请填写备注");
      if (d.occurredOn && !validDate(d.occurredOn))
        throw new AppError("接触日期无效");
      if (d.whySaved === "misheard" && d.sourceType !== "Listening")
        throw new AppError("误听原因仅用于 Listening");
      if (
        ["Reading", "Listening"].includes(d.sourceType) &&
        d.eventKind !== "exposure"
      )
        throw new AppError("阅读/听力事件应为遇见");
      if (d.sourceType === "Writing" && d.eventKind === "exposure")
        throw new AppError("请选择写作事件类型");
      if (
        d.eventKind === "output_corrected" &&
        (d.sourceType !== "Writing" ||
          !d.originalExpression ||
          !d.correctedExpression ||
          d.originalExpression === d.correctedExpression)
      )
        throw new AppError("写作纠正需填写不同的原表达和改进表达");
      const source = this.getSource(d.sourceId);
      if (d.sourceType === "Listening") {
        let seconds: number | null;
        try {
          seconds = parseTimestamp(d.timestamp);
        } catch (e) {
          throw new AppError((e as Error).message);
        }
        if (
          seconds !== null &&
          source.duration !== "" &&
          seconds > source.duration
        )
          throw new AppError("时间位置超过材料时长");
        d.timestampSeconds = seconds;
      } else {
        if (d.timestamp) throw new AppError("时间位置仅适用于 Listening");
        d.timestampSeconds = null;
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
          "SELECT id FROM contexts WHERE expression_id=? AND fingerprint=?",
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
          "INSERT INTO contexts(id,expression_id,source_id,event_kind,data,fingerprint,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          contextId,
          expressionId,
          d.sourceId,
          d.eventKind,
          JSON.stringify(d),
          fingerprint,
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
    const contexts: Context[] = this.all(
      "SELECT c.*,s.title AS source_title,s.type AS source_type FROM contexts c JOIN sources s ON s.id=c.source_id WHERE expression_id=? ORDER BY c.created_at DESC,c.id",
      id,
    ).map((c) => ({
      id: String(c.id),
      sourceId: String(c.source_id),
      sourceTitle: String(c.source_title),
      sourceType: String(c.source_type),
      data: JSON.parse(String(c.data)),
      createdAt: String(c.created_at),
    }));
    return {
      id,
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
    };
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
  return (globalStore.readwordsStore ??= new Store(
    process.env.READWORDS_DB_PATH ||
      resolve(process.cwd(), "data/readwords.sqlite"),
  ));
}
