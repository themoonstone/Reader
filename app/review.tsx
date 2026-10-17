"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import {
  REVIEW_POLICY,
  type ReviewView,
  type ReviewPool,
  type ReviewCandidates,
  type ReviewResult,
} from "@/lib/review-contracts";
import type { Source, Expression } from "@/lib/contracts";
import { ErrorBox, Field } from "./components";
const tabState = globalThis as unknown as { readwordsReviewTab?: string };
const tabId = () => (tabState.readwordsReviewTab ??= crypto.randomUUID());
const elapsedText = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
export function ReviewDetail({ expression }: { expression: Expression }) {
  const [entry, setEntry] = useState<ReviewCandidates["items"][number] | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    let page = 1;
    do {
      const r = await api<ReviewCandidates>(
        `review/candidates?q=${encodeURIComponent(expression.term)}&page=${page}`,
      );
      const match = r.items.find((e) => e.id === expression.id);
      if (match) {
        setEntry(match);
        return;
      }
      if (page * 20 >= r.total) break;
      page++;
    } while (page < 100000);
    setEntry(null);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [expression.id, expression.version]); // loaded metadata only, never changes pool automatically
  return (
    <section className="panel review-detail">
      <h2>近期想练</h2>
      <p>
        收藏不会自动成为练习。活跃池最多 20 个义项，暂停或移出会保留收藏和历史。
      </p>
      <ErrorBox error={error} />
      {entry ? (
        <>
          <p>
            {entry.entry?.state === "active"
              ? "已加入复习池"
              : entry.entry?.state === "paused"
                ? "复习已暂停"
                : "尚未加入复习池"}
            {!entry.eligible && ` · ${entry.reason}`}
          </p>
          <div className="actions">
            {(entry.entry?.state === "active"
              ? ["pause", "remove"]
              : ["resume"]
            ).map((action) => (
              <button
                key={action}
                disabled={busy || (action === "resume" && !entry.eligible)}
                onClick={() => {
                  if (busy) return;
                  setBusy(true);
                  setError("");
                  void (async () => {
                    const row = entry.entry;
                    if (
                      action === "resume" &&
                      (!row || row.state === "not_joined")
                    )
                      await api("review/pool", "POST", {
                        operation_id: crypto.randomUUID(),
                        expression_ids: [expression.id],
                        expected_versions: {
                          [expression.id]: row?.version ?? 0,
                        },
                      });
                    else
                      await api(`review/pool/${row!.id}`, "PATCH", {
                        operation_id: crypto.randomUUID(),
                        entry_version: row!.version,
                        action,
                      });
                    await load();
                  })()
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                {action === "pause"
                  ? "暂停练习"
                  : action === "remove"
                    ? "移出复习池"
                    : entry.entry?.state === "paused"
                      ? "恢复练习"
                      : "加入复习池"}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p>仅未归档的 P1/P2 可加入；需要真实原句或正确改句以及语境释义。</p>
      )}
      <a href="/#review">打开 Review</a>
    </section>
  );
}
export default function ReviewPage({ sources }: { sources: Source[] }) {
  const [view, setView] = useState<ReviewView | null>(null),
    [pool, setPool] = useState<ReviewPool | null>(null),
    [candidates, setCandidates] = useState<ReviewCandidates | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [halted, setHalted] = useState(true),
    [clock, setClock] = useState(0),
    [manage, setManage] = useState(false);
  const [query, setQuery] = useState(""),
    [source, setSource] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<
      Record<string, ReviewCandidates["items"][number]>
    >({});
  const [minutes, setMinutes] = useState(600),
    [cards, setCards] = useState(10),
    [fresh, setFresh] = useState(3);
  const control = useRef({
    view: null as ReviewView | null,
    token: "",
    last: 0,
    queue: Promise.resolve(),
    halted: true,
    mounted: true,
    pending: 0,
  });
  const focus = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (view?.card) focus.current?.focus();
  }, [view?.card?.id]);
  function apply(v: ReviewView) {
    const c = control.current;
    c.view = v;
    if (v.leaseToken) c.token = v.leaseToken;
    c.last = performance.now();
    if (
      v.session?.state !== "running" ||
      !v.lease ||
      v.lease.ownerTab !== tabId() ||
      !c.token
    )
      c.halted = true;
    if (c.mounted) {
      setView(v);
      setHalted(c.halted);
      setClock(v.session?.active_elapsed_ms ?? 0);
    }
  }
  const delta = () => {
    const c = control.current;
    return c.halted
      ? 0
      : Math.min(5000, Math.max(0, Math.floor(performance.now() - c.last)));
  };
  const writer = (extra?: Record<string, unknown>) => {
    const c = control.current,
      v = c.view!;
    return {
      owner_tab: tabId(),
      token: c.token,
      lease_version: v.lease?.version ?? 1,
      session_version: v.session!.version,
      delta_ms: delta(),
      ...extra,
    };
  };
  function work(fn: () => Promise<void>) {
    const c = control.current;
    c.pending++;
    if (c.mounted) setBusy(true);
    c.queue = c.queue
      .then(fn)
      .catch(async (e: Error) => {
        c.halted = true;
        if (c.mounted) {
          setHalted(true);
          setError(e.message);
        }
        try {
          apply(await api<ReviewView>("review/session"));
        } catch {}
      })
      .finally(() => {
        c.pending--;
        if (c.mounted) setBusy(c.pending > 0);
      });
    return c.queue;
  }
  async function refreshPool() {
    setPool(await api<ReviewPool>("review/pool"));
  }
  async function sessionAction(action: string) {
    const v = control.current.view!;
    apply(
      await api<ReviewView>(
        `review/sessions/${v.session!.id}/${action}`,
        "POST",
        writer(
          action === "next" ? { request_id: crypto.randomUUID() } : undefined,
        ),
      ),
    );
    if (control.current.view?.session?.state === "ended") await refreshPool();
  }
  async function cardAction(action: string, result?: ReviewResult) {
    const v = control.current.view!;
    const readonly =
      v.session?.state === "ended" && v.session.end_reason === "time_limit";
    apply(
      await api<ReviewView>(
        `review/cards/${v.card!.id}/${action}`,
        "POST",
        readonly
          ? { card_version: v.card!.version }
          : writer({
              card_version: v.card!.version,
              ...(result ? { result } : {}),
            }),
      ),
    );
    if (control.current.view?.session?.state === "ended") await refreshPool();
    if (control.current.mounted) focus.current?.focus();
  }
  async function pause() {
    const c = control.current,
      v = c.view;
    if (
      v?.session?.state === "running" &&
      v.lease?.ownerTab === tabId() &&
      c.token
    ) {
      const body = writer({ action: "pause" });
      c.halted = true;
      if (c.mounted) setHalted(true);
      apply(
        await api<ReviewView>(
          `review/sessions/${v.session.id}/state`,
          "POST",
          body,
        ),
      );
    }
  }
  useEffect(() => {
    const c = control.current;
    c.mounted = true;
    void work(async () => {
      apply(await api<ReviewView>("review/session"));
      await refreshPool();
    });
    const hide = () => {
      if (document.hidden) void work(pause);
    };
    document.addEventListener("visibilitychange", hide);
    const leave = () => {
      if (c.view?.session?.state === "running" && !c.halted) void work(pause);
    };
    window.addEventListener("pagehide", leave);
    let lastFrame = performance.now(),
      lastBeat = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(),
        v = c.view,
        s = v?.session;
      if (now - lastFrame > REVIEW_POLICY.leaseMs && !c.halted) {
        c.halted = true;
        setHalted(true);
        void work(async () => {
          apply(await api<ReviewView>("review/session"));
        });
      }
      lastFrame = now;
      if (!s || s.state !== "running" || c.halted || document.hidden) return;
      const elapsed =
        s.active_elapsed_ms + (s.issued_count ? Math.max(0, now - c.last) : 0);
      setClock(Math.min(s.budget_seconds * 1000, elapsed));
      if (
        !c.pending &&
        (now - lastBeat >= 5000 || elapsed >= s.budget_seconds * 1000)
      ) {
        lastBeat = now;
        void work(() => sessionAction("heartbeat"));
      }
    }, 250);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
      clearInterval(timer);
      void work(pause);
      c.mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!manage) return;
    let active = true;
    api<ReviewCandidates>(
      `review/candidates?q=${encodeURIComponent(query)}&page=${page}&sourceId=${source}`,
    )
      .then((r) => {
        if (active) setCandidates(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [manage, query, page, source, pool]);
  const s = view?.session,
    c = view?.card,
    open = Boolean(s && s.state !== "ended"),
    owned = Boolean(
      s?.state === "running" && !halted && view?.lease?.ownerTab === tabId(),
    );
  const atLimit = Boolean(s && clock >= s.budget_seconds * 1000),
    canWrite = owned && !busy && !atLimit;
  const unresolved = c && ["shown", "revealed"].includes(c.state);
  const doWork = (fn: () => Promise<void>) => {
    if (control.current.pending) return;
    setError("");
    void work(fn);
  };
  return (
    <div className="review-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">A LITTLE PRACTICE</span>
          <h1>近期想练</h1>
          <p>时间和张数都是上限，随时可以停下来。收藏不会自动加入。</p>
        </div>
        <a href="/guide#review">复习使用说明</a>
      </div>
      <ErrorBox error={error} />
      {view?.notice && <p role="status">{view.notice}</p>}
      {!open && (
        <>
          <section className="panel">
            <h2>本轮最多</h2>
            <div className="review-settings">
              <Field label="练习时间">
                <select
                  value={minutes}
                  onChange={(e) => setMinutes(Number(e.target.value))}
                >
                  {[600, 1200, 1800].map((n) => (
                    <option key={n} value={n}>
                      {n / 60} 分钟
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="展示卡数">
                <select
                  value={cards}
                  onChange={(e) => setCards(Number(e.target.value))}
                >
                  {[5, 10, 20].map((n) => (
                    <option key={n} value={n}>
                      {n} 张
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="首次练习的表达">
                <select
                  value={fresh}
                  onChange={(e) => setFresh(Number(e.target.value))}
                >
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} 个
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p>
              新表达每天最多首次引入 5
              个；跳过也占名额。冷却中的表达不会提前填满本轮。
            </p>
            <button
              disabled={busy || !pool?.activeCount}
              onClick={() =>
                doWork(async () => {
                  control.current.halted = false;
                  apply(
                    await api<ReviewView>("review/sessions", "POST", {
                      request_id: crypto.randomUUID(),
                      owner_tab: tabId(),
                      budget_seconds: minutes,
                      card_limit: cards,
                      new_limit: fresh,
                    }),
                  );
                  setManage(false);
                  await sessionAction("next");
                  focus.current?.focus();
                })
              }
            >
              开始本轮练习
            </button>
          </section>
          {s?.state === "ended" && (
            <section className="panel" aria-label="本轮结果">
              <h2>今天先到这里</h2>
              <p>
                本次有效时长 {elapsedText(s.active_elapsed_ms)} · 展示{" "}
                {s.issued_count} 张 · 实际反馈 {view!.feedbackCount} 张
              </p>
              <p>
                忘了 {view!.results.forgot} · 有点难 {view!.results.hard} · 记得{" "}
                {view!.results.remember}
              </p>
              {s.end_reason === "no_candidates" && (
                <p>这轮没有可练内容，可以去读点新的。</p>
              )}
              {s.end_reason === "time_limit" &&
                c?.state === "shown" &&
                !c.answer && (
                  <button
                    disabled={busy}
                    onClick={() => doWork(() => cardAction("reveal"))}
                  >
                    只读揭晓当前卡
                  </button>
                )}
              {s.end_reason === "time_limit" && c?.answer && (
                <div>
                  <p>{c.front.term}</p>
                  <p>{c.front.sentence}</p>
                  <p>表达义项：{c.answer.meaning}</p>
                  <p>语境释义：{c.answer.contextMeaning}</p>
                </div>
              )}
            </section>
          )}
          <section className="panel">
            <h2>复习池</h2>
            <p>
              已加入 {pool?.activeCount ?? 0}/20 个活跃义项 · 暂停{" "}
              {pool?.entries.filter((e) => e.state === "paused").length ?? 0} 个
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setManage(!manage);
                setSelected({});
              }}
            >
              选择近期想练的表达
            </button>
            {pool?.entries.map((e) => (
              <div className="review-pool-row" key={e.id}>
                <div>
                  <strong>{e.term}</strong>
                  <p>
                    {e.meaning} · {e.priority} ·{" "}
                    {e.state === "active" ? "练习中" : "已暂停"}
                    {e.pause_reason === "material_unavailable"
                      ? "（请先补充材料或调整优先级）"
                      : ""}
                  </p>
                </div>
                <div className="actions">
                  {(e.state === "active"
                    ? ["pause", "remove"]
                    : ["resume", "remove"]
                  ).map((action) => (
                    <button
                      className="secondary"
                      key={action}
                      disabled={busy || (action === "resume" && !e.eligible)}
                      onClick={() =>
                        doWork(async () => {
                          setPool(
                            await api<ReviewPool>(
                              `review/pool/${e.id}`,
                              "PATCH",
                              {
                                operation_id: crypto.randomUUID(),
                                entry_version: e.version,
                                action,
                              },
                            ),
                          );
                        })
                      }
                    >
                      {action === "pause"
                        ? "暂停"
                        : action === "resume"
                          ? "恢复"
                          : "移出"}{" "}
                      {e.term}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {!pool?.entries.length && (
              <p>先挑几条近期愿意练习的表达，无需加入整本书。</p>
            )}
          </section>
          {manage && (
            <section className="panel" aria-label="选择复习表达">
              <h2>选择表达义项</h2>
              <div className="review-settings">
                <Field label="搜索复习候选">
                  <input
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(1);
                    }}
                  />
                </Field>
                <Field label="筛选候选来源">
                  <select
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="">全部来源</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {candidates?.items.map((e) => (
                <label className="review-pool-row" key={e.id}>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${e.term}：${e.meaning}`}
                    checked={Boolean(selected[e.id])}
                    disabled={
                      busy || !e.eligible || e.entry?.state === "active"
                    }
                    onChange={(ev) =>
                      setSelected((old) => {
                        const next = { ...old };
                        if (ev.target.checked) next[e.id] = e;
                        else delete next[e.id];
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{e.term}</strong> · {e.priority}
                    <br />
                    {e.meaning}
                    <br />
                    {e.entry?.state === "active" ? "已在池中" : e.reason}
                  </span>
                </label>
              ))}
              <div className="actions">
                <button
                  disabled={busy || page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </button>
                <span>第 {page} 页</span>
                <button
                  disabled={
                    busy || !candidates || page * 20 >= candidates.total
                  }
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </button>
              </div>
              <p>
                已选 {Object.keys(selected).length} 个义项：
                {Object.values(selected)
                  .map((e) => `${e.term}（${e.meaning}）`)
                  .join("；")}
              </p>
              <button
                disabled={busy || !Object.keys(selected).length}
                onClick={() =>
                  doWork(async () => {
                    const rows = Object.values(selected);
                    setPool(
                      await api<ReviewPool>("review/pool", "POST", {
                        operation_id: crypto.randomUUID(),
                        expression_ids: rows.map((e) => e.id),
                        expected_versions: Object.fromEntries(
                          rows.map((e) => [e.id, e.entry?.version ?? 0]),
                        ),
                      }),
                    );
                    setSelected({});
                  })
                }
              >
                加入所选表达
              </button>
            </section>
          )}
        </>
      )}
      {open && s && (
        <section className="panel review-session">
          <div className="section-bar">
            <p>
              有效时长 {elapsedText(clock)} / 最多 {s.budget_seconds / 60} 分钟
              · 展示 {s.issued_count}/{s.card_limit} 张
            </p>
            <span>{owned ? "练习中" : "已暂停或由其他窗口持有"}</span>
          </div>
          {!owned && (
            <>
              <p>
                点击继续会重新校验材料。另一窗口租约有效时请回到该窗口，或等待约
                15 秒后重试。
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  doWork(async () => {
                    apply(await api<ReviewView>("review/session"));
                    const v = control.current.view!;
                    control.current.halted = false;
                    apply(
                      await api<ReviewView>(
                        `review/sessions/${v.session!.id}/lease`,
                        "POST",
                        {
                          owner_tab: tabId(),
                          lease_version: v.lease?.version ?? 0,
                          session_version: v.session!.version,
                        },
                      ),
                    );
                    focus.current?.focus();
                  })
                }
              >
                继续本轮练习
              </button>
            </>
          )}
          {c && (
            <article aria-label="当前复习卡">
              <h2 ref={focus} tabIndex={-1}>
                {c.front.term}
              </h2>
              <blockquote>{c.front.sentence}</blockquote>
              {c.state === "invalidated" ? (
                <p role="status">材料已修改，这张卡已失效，不保存反馈。</p>
              ) : (
                <>
                  {c.answer && (
                    <div className="review-answer">
                      <h3>表达义项</h3>
                      <p>{c.answer.meaning}</p>
                      <h3>
                        语境释义（
                        {c.answer.contextLanguage === "en"
                          ? "英文导入"
                          : "用户填写"}
                        ）
                      </h3>
                      <p>{c.answer.contextMeaning}</p>
                      <p>
                        {c.answer.simpleParaphrase &&
                          `学习改写（非原文）：${c.answer.simpleParaphrase}`}
                      </p>
                      <small>
                        {c.answer.sourceTitle} {c.answer.chapter}{" "}
                        {c.answer.page && `p. ${c.answer.page}`}{" "}
                        {c.answer.timestamp}
                      </small>
                    </div>
                  )}
                  {c.state === "shown" && (
                    <button
                      disabled={!canWrite}
                      onClick={() => doWork(() => cardAction("reveal"))}
                    >
                      揭晓答案
                    </button>
                  )}
                  {c.state === "revealed" && (
                    <div className="actions">
                      {(
                        [
                          ["forgot", "忘了"],
                          ["hard", "有点难"],
                          ["remember", "记得"],
                        ] as const
                      ).map(([r, label]) => (
                        <button
                          disabled={!canWrite}
                          key={r}
                          onClick={() =>
                            doWork(() => cardAction("feedback", r))
                          }
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {unresolved && (
                <button
                  className="text-button"
                  disabled={!canWrite}
                  onClick={() => doWork(() => cardAction("skip"))}
                >
                  跳过这张
                </button>
              )}
            </article>
          )}
          {(!c || !unresolved) && (
            <button
              disabled={!canWrite}
              onClick={() =>
                doWork(async () => {
                  await sessionAction("next");
                  focus.current?.focus();
                })
              }
            >
              下一张
            </button>
          )}
          <div className="actions review-session-actions">
            <button
              className="secondary"
              disabled={busy || !owned}
              onClick={() => doWork(pause)}
            >
              暂停练习
            </button>
            <button
              className="secondary"
              disabled={busy || !owned}
              onClick={() =>
                doWork(async () => {
                  apply(
                    await api<ReviewView>(
                      `review/sessions/${s.id}/state`,
                      "POST",
                      writer({ action: "end" }),
                    ),
                  );
                  await refreshPool();
                })
              }
            >
              今天先到这里
            </button>
          </div>
          {atLimit && <p role="status">本轮时间已到，正在保存结束位置。</p>}
        </section>
      )}
    </div>
  );
}
