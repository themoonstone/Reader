import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, type Store } from "./store";
import { normalize, type DraftInput } from "./contracts";
import {
  recognitionSentence,
  hasReviewMaterial,
  restartReview,
  reviewProcessId,
} from "./review-storage";
import {
  REVIEW_POLICY,
  reviewEntrySchema,
  reviewSessionSchema,
  reviewCardSchema,
  reviewResultSchema,
  reviewSettingsSchema,
  reviewInterval,
  type ReviewEntry,
  type ReviewCard,
  type ReviewSession,
  type ReviewView,
  type ReviewPool,
  type ReviewCandidates,
} from "./review-contracts";
const uuid = z.uuid(),
  version = z.number().int().positive();
const writer = z.object({
  owner_tab: uuid,
  token: uuid,
  lease_version: version,
  session_version: version,
  delta_ms: z.number().int().min(0).max(5000).default(0),
});
type Writer = z.infer<typeof writer>;
const conflict = (message = "复习状态已变化，请重新读取后再试"): never => {
  throw new AppError(message, 409, "REVIEW_CONFLICT");
};
export class Review {
  constructor(readonly store: Store) {}
  private at() {
    return this.store.clock();
  }
  private now() {
    return new Date(this.at()).toISOString();
  }
  private entry(id: string) {
    const row = this.store.one("SELECT * FROM review_entries WHERE id=?", id);
    if (!row) throw new AppError("池条目不存在", 404);
    return reviewEntrySchema.parse(row);
  }
  private byExpression(id: string) {
    const row = this.store.one(
      "SELECT * FROM review_entries WHERE expression_id=?",
      id,
    );
    return row ? reviewEntrySchema.parse(row) : null;
  }
  private session(id: string) {
    const row = this.store.one("SELECT * FROM review_sessions WHERE id=?", id);
    if (!row) throw new AppError("会话不存在", 404);
    return reviewSessionSchema.parse({
      ...row,
      policy: JSON.parse(String(row.policy)),
    });
  }
  private card(id: string) {
    const row = this.store.one("SELECT * FROM review_cards WHERE id=?", id);
    if (!row) throw new AppError("卡片不存在", 404);
    return reviewCardSchema.parse({
      ...row,
      snapshot: JSON.parse(String(row.snapshot)),
    });
  }
  private sweep() {
    this.store.transaction(() => restartReview(this.store.db, this.now()));
  }
  pool(): ReviewPool {
    this.sweep();
    const entries = this.store
      .all(
        "SELECT id FROM review_entries WHERE state!='not_joined' ORDER BY created_at,id",
      )
      .map((r) => {
        const e = this.entry(String(r.id)),
          x = this.store.expression(e.expression_id);
        return {
          ...e,
          term: x.term,
          meaning: x.meaning,
          priority: x.priority,
          eligible: hasReviewMaterial(this.store.db, x.id),
        };
      });
    return {
      entries,
      activeCount: entries.filter((e) => e.state === "active").length,
      limit: REVIEW_POLICY.poolLimit,
    };
  }
  candidates(query: string, page = 1, sourceId = ""): ReviewCandidates {
    const q = z.string().max(200).parse(query);
    page = z.number().int().min(1).max(100000).parse(page);
    if (sourceId) uuid.parse(sourceId);
    const where =
      "WHERE e.lifecycle='active' AND e.priority IN ('P1','P2') AND (instr(e.normalized_term,?)>0 OR instr(e.meaning,?)>0) AND (?='' OR EXISTS(SELECT 1 FROM contexts c WHERE c.expression_id=e.id AND c.source_id=? AND c.lifecycle='active'))";
    const args = [normalize(q), q, sourceId, sourceId];
    const total = Number(
      this.store.one(
        `SELECT count(*) AS n FROM expressions e ${where}`,
        ...args,
      )!.n,
    );
    const items = this.store
      .all(
        `SELECT e.id,e.term,e.meaning,e.priority FROM expressions e ${where} ORDER BY e.updated_at DESC,e.id LIMIT 20 OFFSET ?`,
        ...args,
        (page - 1) * 20,
      )
      .map((e) => {
        const eligible = hasReviewMaterial(this.store.db, String(e.id));
        return {
          id: String(e.id),
          term: String(e.term),
          meaning: String(e.meaning),
          priority: String(e.priority),
          eligible,
          reason: eligible ? "" : "需补充真实原句或正确改句与语境释义",
          entry: this.byExpression(String(e.id)),
        };
      });
    return { items, total, page };
  }
  add(input: unknown) {
    const body = z
      .object({
        operation_id: uuid,
        expression_ids: z.array(uuid).min(1).max(20),
        expected_versions: z.record(uuid, z.number().int().nonnegative()),
      })
      .parse(input);
    if (new Set(body.expression_ids).size !== body.expression_ids.length)
      throw new AppError("不能重复选择同一义项");
    this.store.transaction(() => {
      const actions = body.expression_ids.map((id) => {
        const old = this.byExpression(id);
        if (old?.last_pool_operation_id === body.operation_id) {
          if (old.state !== "active")
            conflict("这次加入后条目已暂停或移出，不能重放旧意图");
          return { id, old, replay: true };
        }
        if ((old?.version ?? 0) !== body.expected_versions[id]) conflict();
        if (!hasReviewMaterial(this.store.db, id))
          throw new AppError("请选择未归档的 P1/P2，并补充真实语境");
        return { id, old, replay: old?.state === "active" };
      });
      const active = Number(
        this.store.one(
          "SELECT count(*) AS n FROM review_entries WHERE state='active'",
        )!.n,
      );
      if (active + actions.filter((a) => !a.replay).length > 20)
        throw new AppError("活跃池最多 20 个义项，请先暂停或移出一些表达");
      for (const a of actions) {
        if (a.replay) continue;
        const now = this.now();
        if (a.old)
          this.store.db
            .prepare(
              "UPDATE review_entries SET state='active',pause_reason='',eligible_after=?,version=version+1,last_pool_operation_id=?,updated_at=? WHERE id=?",
            )
            .run(
              a.old.eligible_after && a.old.eligible_after < now
                ? now
                : a.old.eligible_after,
              body.operation_id,
              now,
              a.old.id,
            );
        else
          this.store.db
            .prepare(
              "INSERT INTO review_entries(id,expression_id,state,pause_reason,stage,version,last_pool_operation_id,created_at,updated_at) VALUES(?,?,'active','',0,1,?,?,?)",
            )
            .run(randomUUID(), a.id, body.operation_id, now, now);
      }
    });
    return this.pool();
  }
  updatePool(id: string, input: unknown) {
    const b = z
      .object({
        operation_id: uuid,
        entry_version: version,
        action: z.enum(["pause", "resume", "remove"]),
      })
      .parse(input);
    this.store.transaction(() => {
      const e = this.entry(id),
        state =
          b.action === "pause"
            ? "paused"
            : b.action === "resume"
              ? "active"
              : "not_joined";
      if (e.last_pool_operation_id === b.operation_id) {
        if (e.state !== state) conflict();
        return;
      }
      if (e.version !== b.entry_version) conflict();
      if (state === "active") {
        if (!hasReviewMaterial(this.store.db, e.expression_id))
          throw new AppError("材料暂不可练，请先修正表达或语境");
        if (
          e.state !== "active" &&
          Number(
            this.store.one(
              "SELECT count(*) AS n FROM review_entries WHERE state='active'",
            )!.n,
          ) >= 20
        )
          throw new AppError("活跃池已满，请先暂停或移出其他表达");
      }
      const now = this.now();
      this.store.db
        .prepare(
          "UPDATE review_entries SET state=?,pause_reason=?,eligible_after=?,version=version+1,last_pool_operation_id=?,updated_at=? WHERE id=?",
        )
        .run(
          state,
          state === "paused" ? "user" : "",
          state === "active" && e.eligible_after && e.eligible_after < now
            ? now
            : e.eligible_after,
          b.operation_id,
          now,
          id,
        );
    });
    return this.pool();
  }
  private lease(id: string) {
    return this.store.one("SELECT * FROM review_leases WHERE session_id=?", id);
  }
  view(id?: string, notice?: string, readonlyAnswer = false): ReviewView {
    if (!id) {
      const row = this.store.one(
        "SELECT id FROM review_sessions ORDER BY CASE WHEN state!='ended' THEN 0 ELSE 1 END,started_at DESC,id DESC LIMIT 1",
      );
      if (!row)
        return {
          session: null,
          card: null,
          feedbackCount: 0,
          results: { forgot: 0, hard: 0, remember: 0 },
        };
      id = String(row.id);
    }
    const session = this.session(id);
    const c = session.current_card_id
      ? this.card(session.current_card_id)
      : null;
    const results = { forgot: 0, hard: 0, remember: 0 };
    for (const r of this.store.all(
      "SELECT result,count(*) AS n FROM review_records WHERE session_id=? GROUP BY result",
      id,
    ))
      results[r.result as keyof typeof results] = Number(r.n);
    const lease = this.lease(id);
    let card: ReviewView["card"] = null;
    if (c) {
      const { snapshot, ...fields } = c;
      card = {
        ...fields,
        front: snapshot.front,
        ...((c.state === "revealed" ||
          c.state === "answered" ||
          readonlyAnswer) &&
        c.state !== "invalidated"
          ? { answer: snapshot.answer }
          : {}),
      };
    }
    return {
      session,
      card,
      feedbackCount: results.forgot + results.hard + results.remember,
      results,
      notice,
      ...(lease
        ? {
            lease: {
              ownerTab: String(lease.owner_tab),
              expiresAt: String(lease.expires_at),
              version: Number(lease.version),
            },
          }
        : {}),
    };
  }
  current() {
    this.sweep();
    return this.view();
  }
  start(input: unknown) {
    const b = reviewSettingsSchema
      .extend({ request_id: uuid, owner_tab: uuid })
      .parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const old = this.store.one(
        "SELECT id FROM review_sessions WHERE start_request_id=?",
        b.request_id,
      );
      if (old) {
        const s = this.session(String(old.id));
        if (
          s.budget_seconds !== b.budget_seconds ||
          s.card_limit !== b.card_limit ||
          s.new_limit !== b.new_limit
        )
          conflict("同一开始请求不能更换设置");
        const l = this.lease(s.id);
        return {
          ...this.view(s.id),
          ...(l?.owner_tab === b.owner_tab
            ? { leaseToken: String(l.token) }
            : {}),
        };
      }
      if (this.store.one("SELECT id FROM review_sessions WHERE state!='ended'"))
        conflict("已有未结束会话，请继续或先结束它");
      const id = randomUUID(),
        now = this.now(),
        token = randomUUID();
      this.store.db
        .prepare(
          "INSERT INTO review_sessions(id,start_request_id,state,budget_seconds,card_limit,new_limit,active_elapsed_ms,issued_count,introduced_count,current_card_id,policy_version,policy,version,started_at,ended_at,end_reason,last_checkpoint_at) VALUES(?,?,'running',?,?,?,0,0,0,NULL,'low-pressure-v1',?,1,?,NULL,'',?)",
        )
        .run(
          id,
          b.request_id,
          b.budget_seconds,
          b.card_limit,
          b.new_limit,
          JSON.stringify(REVIEW_POLICY),
          now,
          now,
        );
      this.store.db
        .prepare("INSERT INTO review_leases VALUES(?,?,?,1,?,?)")
        .run(
          id,
          b.owner_tab,
          token,
          new Date(this.at() + 15000).toISOString(),
          reviewProcessId(),
        );
      return { ...this.view(id), leaseToken: token };
    });
  }
  claim(id: string, input: unknown) {
    const b = z
      .object({
        owner_tab: uuid,
        lease_version: z.number().int().nonnegative(),
        session_version: version,
      })
      .parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const s = this.session(id),
        l = this.lease(id);
      if (s.state === "ended") conflict("本轮已经结束");
      if (s.version !== b.session_version) conflict();
      if (l && l.owner_tab !== b.owner_tab)
        conflict("另一窗口正在练习，请回到该窗口或等租约过期后继续");
      if (Number(l?.version ?? 0) !== b.lease_version) conflict();
      const token = randomUUID(),
        lv = Number(l?.version ?? 0) + 1;
      this.store.db
        .prepare("INSERT OR REPLACE INTO review_leases VALUES(?,?,?,?,?,?)")
        .run(
          id,
          b.owner_tab,
          token,
          lv,
          new Date(this.at() + 15000).toISOString(),
          reviewProcessId(),
        );
      this.store.db
        .prepare(
          "UPDATE review_sessions SET state='running',last_checkpoint_at=?,version=version+1 WHERE id=?",
        )
        .run(this.now(), id);
      return { ...this.view(id), leaseToken: token };
    });
  }
  private checkWriter(s: ReviewSession, b: Writer) {
    const l = this.lease(s.id);
    if (
      s.state !== "running" ||
      !l ||
      l.owner_tab !== b.owner_tab ||
      l.token !== b.token ||
      Number(l.version) !== b.lease_version ||
      String(l.expires_at) <= this.now()
    )
      conflict("会话已暂停或由其他窗口持有，请读取最新状态再继续");
    if (s.version !== b.session_version) conflict();
  }
  private end(id: string, reason: ReviewSession["end_reason"]) {
    this.store.db
      .prepare(
        "UPDATE review_sessions SET state='ended',end_reason=?,ended_at=?,version=version+1 WHERE id=?",
      )
      .run(reason, this.now(), id);
    this.store.db
      .prepare("DELETE FROM review_leases WHERE session_id=?")
      .run(id);
  }
  private tick(s: ReviewSession, b: Writer) {
    const delta = s.issued_count
      ? Math.min(
          b.delta_ms,
          5000,
          Math.max(0, this.at() - Date.parse(s.last_checkpoint_at)),
        )
      : 0;
    const elapsed = Math.min(
      s.budget_seconds * 1000,
      s.active_elapsed_ms + delta,
    );
    this.store.db
      .prepare(
        "UPDATE review_sessions SET active_elapsed_ms=?,last_checkpoint_at=?,version=version+1 WHERE id=?",
      )
      .run(elapsed, this.now(), s.id);
    this.store.db
      .prepare("UPDATE review_leases SET expires_at=? WHERE session_id=?")
      .run(new Date(this.at() + 15000).toISOString(), s.id);
    if (elapsed >= s.budget_seconds * 1000) this.end(s.id, "time_limit");
    return this.session(s.id);
  }
  heartbeat(id: string, input: unknown) {
    const b = writer.parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const s = this.session(id);
      this.checkWriter(s, b);
      this.tick(s, b);
      return this.view(id);
    });
  }
  state(id: string, input: unknown) {
    const b = writer
      .extend({ action: z.enum(["pause", "resume", "end"]) })
      .parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const s = this.session(id);
      if (b.action === "end" && s.state === "ended") return this.view(id);
      if (b.action === "pause" && s.state === "paused") return this.view(id);
      this.checkWriter(s, b);
      const after = this.tick(s, b);
      if (after.state === "ended") return this.view(id);
      if (b.action === "end") this.end(id, "user");
      else if (b.action === "pause") {
        this.store.db
          .prepare(
            "UPDATE review_sessions SET state='paused',version=version+1 WHERE id=?",
          )
          .run(id);
        this.store.db
          .prepare("DELETE FROM review_leases WHERE session_id=?")
          .run(id);
      }
      return this.view(id);
    });
  }
  private currentCardValid(c: ReviewCard) {
    const e = this.store.one(
        "SELECT * FROM expressions WHERE id=?",
        c.expression_id,
      ),
      entry = this.entry(c.entry_id);
    const ctx = this.store.one(
      "SELECT c.*,s.version AS source_version FROM contexts c JOIN sources s ON s.id=c.source_id WHERE c.id=?",
      c.context_id,
    );
    return (
      c.state !== "invalidated" &&
      entry.state === "active" &&
      entry.version === c.entry_version &&
      e?.lifecycle === "active" &&
      ["P1", "P2"].includes(String(e.priority)) &&
      Number(e.version) === c.expression_version &&
      ctx?.expression_id === c.expression_id &&
      ctx?.lifecycle === "active" &&
      Number(ctx.version) === c.context_version &&
      Number(ctx.source_version) === c.source_version
    );
  }
  next(id: string, input: unknown) {
    const b = writer.extend({ request_id: uuid }).parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const prior = this.store.one(
        "SELECT id,session_id FROM review_cards WHERE issue_request_id=?",
        b.request_id,
      );
      if (prior) {
        if (prior.session_id !== id) conflict();
        return { ...this.view(id), issuedCardId: String(prior.id) };
      }
      const s = this.session(id);
      this.checkWriter(s, b);
      const after = this.tick(s, b);
      if (after.state === "ended")
        return this.view(id, "本轮时间已到，可以休息了");
      if (
        after.current_card_id &&
        ["shown", "revealed"].includes(this.card(after.current_card_id).state)
      )
        conflict("请先反馈或跳过当前卡");
      if (after.issued_count >= after.card_limit) {
        this.end(id, "card_limit");
        return this.view(id);
      }
      const already = new Set(
        this.store
          .all("SELECT expression_id FROM review_cards WHERE session_id=?", id)
          .map((r) => String(r.expression_id)),
      );
      const pool = this.store
        .all("SELECT id FROM review_entries WHERE state='active'")
        .map((r) => this.entry(String(r.id)))
        .filter(
          (e) =>
            !already.has(e.expression_id) &&
            hasReviewMaterial(this.store.db, e.expression_id),
        );
      const priority = (e: ReviewEntry) =>
        this.store.one(
          "SELECT priority FROM expressions WHERE id=?",
          e.expression_id,
        )!.priority === "P1"
          ? 0
          : 1;
      const old = pool
        .filter(
          (e) =>
            e.first_presented_at &&
            (!e.eligible_after || e.eligible_after <= this.now()),
        )
        .sort(
          (a, b) =>
            (a.last_presented_at || "").localeCompare(
              b.last_presented_at || "",
            ) ||
            priority(a) - priority(b) ||
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        );
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const localDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(this.at()));
      const introduced = Number(
        this.store.one(
          "SELECT count(*) AS n FROM review_cards WHERE is_first_presentation=1 AND presented_local_date=?",
          localDate,
        )!.n,
      );
      const fresh =
        after.introduced_count < after.new_limit && introduced < 5
          ? pool
              .filter((e) => !e.first_presented_at)
              .sort(
                (a, b) =>
                  priority(a) - priority(b) ||
                  a.created_at.localeCompare(b.created_at) ||
                  a.id.localeCompare(b.id),
              )
          : [];
      const entry = old[0] ?? fresh[0];
      if (!entry) {
        this.end(id, "no_candidates");
        return this.view(id, "这轮没有可练内容，可以去读点新的");
      }
      const expression = this.store.expression(entry.expression_id);
      const contexts = expression.contexts
        .filter((c) => c.data.meaning && recognitionSentence(c.data))
        .map((c) => ({
          ...c,
          last: this.store.one(
            "SELECT max(created_at) AS t FROM review_cards WHERE context_id=?",
            c.id,
          )!.t as string | null,
        }))
        .sort(
          (a, b) =>
            (a.last ?? "").localeCompare(b.last ?? "") ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      const context = contexts[0],
        data = context.data,
        source = this.store.getSource(context.sourceId),
        now = this.now(),
        cardId = randomUUID(),
        first = entry.first_presented_at ? 0 : 1;
      this.store.db
        .prepare(
          "UPDATE review_entries SET first_presented_at=coalesce(first_presented_at,?),first_presented_local_date=coalesce(first_presented_local_date,?),first_presented_timezone=coalesce(first_presented_timezone,?),last_presented_at=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(now, localDate, timezone, now, now, entry.id);
      const snapshot = {
        front: { term: expression.term, sentence: recognitionSentence(data) },
        answer: {
          meaning: expression.meaning,
          contextMeaning: data.meaning,
          simpleParaphrase: data.importMetadata?.simpleParaphrase || "",
          contextLanguage:
            data.importMetadata &&
            data.meaning === data.importMetadata.contextMeaningEnglish
              ? "en"
              : "user",
          sourceTitle: source.title,
          sourceType: source.type,
          chapter: data.chapter,
          page: data.page,
          timestamp: data.timestamp,
        },
      };
      this.store.db
        .prepare(
          "INSERT INTO review_cards(id,session_id,entry_id,expression_id,context_id,issue_request_id,review_type,state,snapshot,expression_version,context_version,source_version,entry_version,is_first_presentation,presented_local_date,presented_timezone,version,created_at,revealed_at) VALUES(?,?,?,?,?,?,'recognition','shown',?,?,?,?,?,?,?,?,1,?,NULL)",
        )
        .run(
          cardId,
          id,
          entry.id,
          expression.id,
          context.id,
          b.request_id,
          JSON.stringify(snapshot),
          expression.version,
          context.version,
          source.version,
          entry.version + 1,
          first,
          localDate,
          timezone,
          now,
        );
      this.store.db
        .prepare(
          "UPDATE review_sessions SET issued_count=issued_count+1,introduced_count=introduced_count+?,current_card_id=?,version=version+1 WHERE id=?",
        )
        .run(first, cardId, id);
      return { ...this.view(id), issuedCardId: cardId };
    });
  }
  reveal(cardId: string, input: unknown) {
    const shape = z
      .object({ card_version: version })
      .passthrough()
      .parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const c = this.card(cardId),
        s = this.session(c.session_id);
      if (
        c.version !== shape.card_version &&
        !(c.state === "revealed" && shape.card_version === c.version - 1)
      )
        conflict();
      if (!this.currentCardValid(c))
        return this.view(s.id, "材料已修改，这张卡已失效");
      if (s.state === "ended" && s.end_reason === "time_limit")
        return this.view(s.id, "本轮时间已到，仅查看答案，不保存反馈", true);
      if (c.state === "revealed") return this.view(s.id);
      if (
        c.state !== "shown" ||
        c.version !== shape.card_version ||
        s.current_card_id !== cardId
      )
        conflict();
      const b = writer.parse(input);
      this.checkWriter(s, b);
      const after = this.tick(s, b);
      if (after.state === "ended")
        return this.view(s.id, "本轮时间已到，仅查看答案，不保存反馈", true);
      this.store.db
        .prepare(
          "UPDATE review_cards SET state='revealed',revealed_at=?,version=version+1 WHERE id=?",
        )
        .run(this.now(), cardId);
      return this.view(s.id);
    });
  }
  feedback(cardId: string, input: unknown) {
    const b = writer
      .extend({ card_version: version, result: reviewResultSchema })
      .parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const c = this.card(cardId);
      const prior = this.store.one(
        "SELECT result FROM review_records WHERE card_id=?",
        cardId,
      );
      if (prior) {
        if (prior.result !== b.result) conflict("这张卡已保存另一种反馈");
        return this.view(c.session_id, "反馈已保存，不重复计入");
      }
      const s = this.session(c.session_id);
      this.checkWriter(s, b);
      if (!this.currentCardValid(c))
        return this.view(s.id, "材料已修改，未保存旧卡反馈");
      if (
        c.state !== "revealed" ||
        c.version !== b.card_version ||
        s.current_card_id !== cardId
      )
        conflict("先揭晓当前卡再反馈");
      const after = this.tick(s, b);
      if (after.state === "ended")
        return this.view(s.id, "本轮时间已到，未保存反馈");
      const e = this.entry(c.entry_id),
        next = reviewInterval(e.stage, b.result, this.at()),
        now = this.now();
      this.store.db
        .prepare(
          "INSERT INTO review_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          c.id,
          s.id,
          e.id,
          c.expression_id,
          c.context_id,
          "recognition",
          b.result,
          now,
          e.stage,
          next.stage,
          e.eligible_after,
          next.eligibleAfter,
          "low-pressure-v1",
          JSON.stringify(c.snapshot),
        );
      this.store.db
        .prepare(
          "UPDATE review_entries SET stage=?,eligible_after=?,last_reviewed_at=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(next.stage, next.eligibleAfter, now, now, e.id);
      this.store.db
        .prepare(
          "UPDATE review_cards SET state='answered',version=version+1 WHERE id=?",
        )
        .run(cardId);
      if (after.issued_count >= after.card_limit) this.end(s.id, "card_limit");
      return this.view(s.id, "反馈已保存");
    });
  }
  skip(cardId: string, input: unknown) {
    const b = writer.extend({ card_version: version }).parse(input);
    this.sweep();
    return this.store.transaction(() => {
      const c = this.card(cardId);
      if (c.state === "skipped" || c.state === "invalidated")
        return this.view(c.session_id);
      const s = this.session(c.session_id);
      this.checkWriter(s, b);
      if (
        c.state === "answered" ||
        c.version !== b.card_version ||
        s.current_card_id !== cardId
      )
        conflict();
      const after = this.tick(s, b);
      if (after.state === "ended") return this.view(s.id);
      this.store.db
        .prepare(
          "UPDATE review_cards SET state='skipped',version=version+1 WHERE id=?",
        )
        .run(cardId);
      if (after.issued_count >= after.card_limit) this.end(s.id, "card_limit");
      return this.view(s.id);
    });
  }
}
