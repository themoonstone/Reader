"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, displayDate } from "@/lib/client";
import {
  sourceTypes,
  type Source,
  type Draft,
  type Expression,
} from "@/lib/contracts";
import { Capture, Empty, ErrorBox, Modal, SourceForm } from "./components";
import DraftEditor from "./draft-editor";
import Maintenance, { Trash } from "./maintenance";
import ReviewPage, { ReviewDetail } from "./review";
import Account from "./account";
import BackupSettings from "./backup-settings";
import ExcelImporter from "./excel-importer";
import SourceMerge from "./source-merge";
import ContextCard from "./context-card";
import BookFlashcardPage from "./book-flashcards";
import {
  readBrowse,
  listParams,
  browseIds,
  browseNeighbor,
  type BrowseContext,
} from "@/lib/browse";

const symbols: Record<string, string> = {
  Reading: "▤",
  Listening: "◉",
  Writing: "✎",
  Manual: "✧",
};
export default function Workspace({ cloud = false }: { cloud?: boolean }) {
  const [view, setView] = useState("library");
  const [sources, setSources] = useState<Source[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [expressions, setExpressions] = useState<Expression[]>([]);
  const [detail, setDetail] = useState<Expression | null>(null);
  const primaryContext = detail?.contexts.find((c) => c.data.sentence.trim());
  const otherContexts =
    detail?.contexts.filter((c) => c.id !== primaryContext?.id) || [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [archived, setArchived] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [capture, setCapture] = useState(false);
  const [sourceModal, setSourceModal] = useState<Source | "new" | null>(null);
  const [mergeSource, setMergeSource] = useState<Source | "choose" | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [supportingReady, setSupportingReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [browse, setBrowse] = useState<BrowseContext | null>(null);
  const [loadedListKey, setLoadedListKey] = useState("");
  const [browseLive, setBrowseLive] = useState<{
    key: string;
    ids: string[];
    error: string;
  } | null>(null);
  const restoreList = useRef<BrowseContext | null>(null);
  const renderedRoute = useRef("library");
  const listKey = JSON.stringify([
    view,
    listParams(view, query, type, priority, archived),
    revision,
  ]);
  const browseKey =
    view.startsWith("expression/") && browse
      ? JSON.stringify([
          browse.origin,
          listParams(
            browse.origin,
            browse.query,
            browse.type,
            browse.priority,
            browse.archived,
          ),
          browse.ids,
        ])
      : "";
  const currentId = view.startsWith("expression/") ? view.slice(11) : "";
  const liveReady =
    !!browseKey &&
    browseLive?.key === `${browseKey}:${currentId}:${revision}` &&
    !browseLive.error;
  const liveIds = liveReady ? browseLive!.ids : [];
  const sequence = browse ? browseIds(browse, liveIds) : [];
  const previousId =
    browse && liveReady
      ? browseNeighbor(browse, liveIds, currentId, -1)
      : undefined;
  const nextId =
    browse && liveReady
      ? browseNeighbor(browse, liveIds, currentId, 1)
      : undefined;
  const dirty = useRef(false);
  const onDirty = useCallback((v: boolean) => {
    dirty.current = v;
  }, []);
  const refresh = () => setRevision((r) => r + 1);
  const navigate = (next: string, context: BrowseContext | null = null) => {
    if (
      dirty.current &&
      !window.confirm("草稿尚未保存，确定离开？可先保存草稿或复制当前输入。")
    )
      return;
    dirty.current = false;
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    window.history.replaceState(
      { ...window.history.state, readwordsBrowse: context },
      "",
    );
    window.dispatchEvent(new Event("readwords-navigate"));
  };
  useEffect(() => {
    let previous = window.location.hash || "#library";
    let previousState = window.history.state;
    const scrollMode = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const read = () => {
      if (
        dirty.current &&
        !window.confirm("草稿尚未保存，确定离开？可先保存或复制当前输入。")
      ) {
        window.history.replaceState(previousState, "", previous);
        return;
      }
      dirty.current = false;
      previous = window.location.hash || "#library";
      previousState = window.history.state;
      const next = previous.slice(1);
      const stored = readBrowse(window.history.state?.readwordsBrowse);
      const context =
        stored &&
        (next === stored.origin || next === `expression/${stored.anchor}`)
          ? stored
          : null;
      setBrowse(context);
      restoreList.current = context && next === context.origin ? context : null;
      if (context) {
        setQuery(context.query);
        setType(context.type);
        setPriority(context.priority);
        setArchived(context.archived);
      } else {
        setType("");
      }
      // Do not mount a new route briefly before its loading effect starts:
      // an early file selection or form input would otherwise be discarded.
      if (renderedRoute.current !== next) setLoading(true);
      renderedRoute.current = next;
      setView(next);
      if (!restoreList.current) window.scrollTo(0, 0);
      setError("");
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("readwords-navigate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("readwords-navigate", read);
      window.history.scrollRestoration = scrollMode;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setDetail(null);
    setDraft(null);
    setSupportingReady(false);
    const reportError = (e: unknown) => {
      if (active) setError((e as Error).message);
    };
    const supporting = Promise.all([
      api<Source[]>("sources"),
      api<Draft[]>("drafts"),
    ]).then(([s, d]) => {
      if (!active) return;
      setSources(s);
      setDrafts(d);
      setSupportingReady(true);
    });
    const load = async () => {
      if (view.startsWith("expression/")) {
        // The current expression is independent of the source/Inbox refresh.
        // Attach the background error handler before awaiting the primary request.
        void supporting.catch(reportError);
        const item = await api<Expression>(`expressions/${view.split("/")[1]}`);
        if (active) setDetail(item);
        return;
      }
      const item = view.startsWith("draft/")
        ? api<Draft>(`drafts/${view.split("/")[1]}`)
        : Promise.resolve(null);
      const [, currentDraft] = await Promise.all([supporting, item]);
      if (active && currentDraft) setDraft(currentDraft);
    };
    load()
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [view, revision]);
  useEffect(() => {
    if (view !== "search" && !view.startsWith("source/")) return;
    let active = true;
    setLoadedListKey("");
    const params = listParams(view, query, type, priority, archived);
    const timer = setTimeout(
      () =>
        api<Expression[]>(`expressions?${params}`)
          .then((result) => {
            if (active) {
              setExpressions(result);
              setLoadedListKey(listKey);
            }
          })
          .catch((e) => {
            if (active) setError((e as Error).message);
          }),
      180,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [view, query, type, priority, archived, revision, listKey]);
  useEffect(() => {
    if (!browseKey) return;
    let active = true;
    const [, params] = JSON.parse(browseKey) as [string, string];
    api<string[]>(`expressions?${params}&idsOnly=1`)
      .then((items) => {
        if (active)
          setBrowseLive({
            key: `${browseKey}:${currentId}:${revision}`,
            ids: items,
            error: "",
          });
      })
      .catch((e: Error) => {
        if (active)
          setBrowseLive({
            key: `${browseKey}:${currentId}:${revision}`,
            ids: [],
            error: e.message,
          });
      });
    return () => {
      active = false;
    };
  }, [browseKey, currentId, revision]);
  useEffect(() => {
    const context = restoreList.current;
    if (
      !context ||
      loading ||
      loadedListKey !== listKey ||
      view !== context.origin
    )
      return;
    const frame = requestAnimationFrame(() => {
      const ids = expressions.map((e) => e.id);
      const anchor = ids.includes(context.anchor)
        ? context.anchor
        : browseNeighbor(context, ids, context.anchor, 1) ||
          browseNeighbor(context, ids, context.anchor, -1);
      const element = anchor
        ? document.querySelector<HTMLButtonElement>(
            `[data-expression-id="${anchor}"]`,
          )
        : null;
      if (element) {
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: "center" });
      } else window.scrollTo(0, context.scrollY);
      restoreList.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [view, loading, loadedListKey, listKey, expressions]);
  useEffect(() => {
    if (!cloud) return;
    const foreground = () => {
      if (
        document.hidden ||
        view === "review" ||
        view.startsWith("flashcards/")
      )
        return;
      if (dirty.current || capture || sourceModal || view === "import") {
        setNotice("其他设备的数据可能已变化；当前输入保留，保存后再刷新。");
        return;
      }
      setRevision((r) => r + 1);
    };
    document.addEventListener("visibilitychange", foreground);
    return () => document.removeEventListener("visibilitychange", foreground);
  }, [cloud, capture, sourceModal, view]);
  const sourceAdded = (source: Source) =>
    setSources((s) => [source, ...s.filter((v) => v.id !== source.id)]);
  const activeSource = view.startsWith("source/")
    ? sources.find((s) => s.id === view.split("/")[1])
    : undefined;
  const section = view.split("/")[0];
  const navActive =
    section === "source" || section === "import" || section === "flashcards"
      ? "library"
      : section === "draft"
        ? "inbox"
        : section === "expression"
          ? browse?.origin.startsWith("source/")
            ? "library"
            : "search"
          : section;
  const sourceList = sources.filter(
    (s) =>
      s.lifecycle === (archived ? "archived" : "active") &&
      (!type || s.type === type),
  );
  const cards = (items: Expression[]) =>
    items.length ? (
      <div className="expression-list">
        {items.map((e) => (
          <button
            className="expression-card"
            key={e.id}
            aria-label={`查看表达 ${e.term} · ${e.meaning}`}
            data-expression-id={e.id}
            onClick={() => {
              const context: BrowseContext = {
                version: 1,
                origin: view,
                query,
                type: type as BrowseContext["type"],
                priority: priority as BrowseContext["priority"],
                archived,
                ids: items.map((item) => item.id),
                anchor: e.id,
                scrollY: window.scrollY,
              };
              window.history.replaceState(
                { ...window.history.state, readwordsBrowse: context },
                "",
              );
              navigate(`expression/${e.id}`, context);
            }}
          >
            <div>
              <span className={`badge ${e.priority.toLowerCase()}`}>
                {e.priority}
              </span>
              <h3 className="serif">{e.term}</h3>
              <p>{e.meaning}</p>
              {query && <small>匹配：{e.matches?.join(" · ")}</small>}
            </div>
            <div className="expression-meta">
              <span>
                {e.contextCount} 个语境 · {e.sourceCount} 个来源
              </span>
              <span>
                Seen {e.seen} · Used {e.used}　↗
              </span>
            </div>
          </button>
        ))}
      </div>
    ) : (
      <Empty title={query ? "还没有找到这个表达" : "这里还没有表达"}>
        <p>从真实语料中留下第一条记录。</p>
        <button className="secondary" onClick={() => setCapture(true)}>
          ＋ 记录表达
        </button>
      </Empty>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#library"
          onClick={(e) => {
            e.preventDefault();
            navigate("library");
          }}
        >
          <span className="brand-mark">
            r<span>·</span>
          </span>
          <div>
            ReadWords<small>你的个人表达库</small>
          </div>
        </a>
        <Account />
        <span className="nav-label">WORKSPACE</span>
        <nav aria-label="主导航">
          {[
            ["library", "▤", "Library", "来源库"],
            ["inbox", "▣", "Inbox", "收件箱"],
            ["review", "◷", "Review", "轻量复习"],
            ["search", "⌕", "Search", "搜索"],
          ].map(([key, icon, label, zh]) => (
            <button
              key={key}
              className={`nav-item ${navActive === key ? "active" : ""}`}
              aria-current={navActive === key ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <span className="nav-icon" aria-hidden="true">
                {icon}
              </span>
              <span>
                {label}
                <small>{zh}</small>
              </span>
              {key === "inbox" &&
                drafts.filter((d) => d.state === "pending").length > 0 && (
                  <span className="nav-count">
                    {drafts.filter((d) => d.state === "pending").length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span aria-hidden="true">✧</span>
          <p>
            从真正遇见的英语里，
            <br />
            慢慢积累自己的表达。
          </p>
        </div>
        <button className="local-status" onClick={() => navigate("settings")}>
          <span className="status-dot" />
          {cloud ? "云端工作空间" : "本地工作空间"}
          <span>⚙</span>
        </button>
      </aside>
      <main>
        <header className="topbar">
          <span>
            个人语料学习 /{" "}
            <strong>
              {navActive === "library"
                ? "来源库"
                : navActive === "inbox"
                  ? "收件箱"
                  : navActive === "search"
                    ? "表达库"
                    : navActive === "review"
                      ? "复习"
                      : "设置"}
            </strong>
          </span>
          <div className="actions">
            <a
              className="guide-entry"
              href="/guide"
              target="_blank"
              rel="noopener noreferrer"
            >
              使用指南 ↗
            </a>
            <button className="secondary" onClick={() => navigate("import")}>
              导入 Excel
            </button>
            <button onClick={() => setCapture(true)}>＋ 记录表达</button>
          </div>
        </header>
        <div className="content">
          {notice && (
            <div className="success" role="status">
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                关闭
              </button>
            </div>
          )}
          <ErrorBox error={error} />
          {error && (
            <button className="secondary" onClick={refresh}>
              重新连接 / 重试
            </button>
          )}
          {currentId && (
            <nav className="detail-browse" aria-label="表达连续浏览">
              <button
                className="text-button back"
                onClick={() => navigate(browse?.origin || "search", browse)}
              >
                {browse
                  ? browse.origin === "search"
                    ? "← 返回搜索结果"
                    : "← 返回来源列表"
                  : "← 返回表达库"}
              </button>
              {browse ? (
                <>
                  <span className="muted" role="status">
                    {!liveReady
                      ? browseLive?.key ===
                          `${browseKey}:${currentId}:${revision}` &&
                        browseLive.error
                        ? "浏览列表核对失败，请重试"
                        : "正在核对浏览列表…"
                      : sequence.includes(currentId)
                        ? `第 ${sequence.indexOf(currentId) + 1} / ${sequence.length} 条 · ${browse.origin === "search" ? "搜索结果" : "当前来源"}`
                        : "当前表达已不在结果中"}
                  </span>
                  <div className="actions">
                    <button
                      className="secondary"
                      disabled={loading || !previousId}
                      onClick={() =>
                        previousId &&
                        navigate(`expression/${previousId}`, {
                          ...browse,
                          anchor: previousId,
                        })
                      }
                    >
                      ← 上一条
                    </button>
                    <button
                      className="secondary"
                      disabled={loading || !nextId}
                      onClick={() =>
                        nextId &&
                        navigate(`expression/${nextId}`, {
                          ...browse,
                          anchor: nextId,
                        })
                      }
                    >
                      下一条 →
                    </button>
                    {browseLive?.key ===
                      `${browseKey}:${currentId}:${revision}` &&
                      browseLive.error && (
                        <button className="text-button" onClick={refresh}>
                          重试浏览列表
                        </button>
                      )}
                  </div>
                </>
              ) : (
                <span className="muted">
                  从来源或搜索列表进入，可使用上一条 / 下一条。
                </span>
              )}
            </nav>
          )}
          {loading ? (
            <div className="empty" role="status">
              正在读取工作空间…
            </div>
          ) : (
            <>
              {view === "library" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">YOUR LANGUAGE, IN CONTEXT</span>
                      <h1>每一种遇见，都值得留下。</h1>
                      <p>书页、声音与自己的文字，在这里汇成一座表达库。</p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => setSourceModal("new")}
                    >
                      ＋ 新建来源
                    </button>
                  </div>
                  {sources.filter((s) => s.lifecycle === "active").length >
                    1 && (
                    <button
                      className="text-button"
                      onClick={() => setMergeSource("choose")}
                    >
                      合并来源
                    </button>
                  )}
                  <section className="library-banner">
                    <div>
                      <span className="eyebrow">CONTEXT FIRST</span>
                      <h2 className="serif">
                        Learn from what you
                        <br />
                        actually read, hear, and write.
                      </h2>
                      <p>不急着记住所有词。从一个真正用得上的表达开始。</p>
                      <button onClick={() => setCapture(true)}>
                        记录一个表达 <span>↗</span>
                      </button>
                    </div>
                    <div className="banner-art" aria-hidden="true">
                      <div className="paper paper-back">hear.</div>
                      <div className="paper paper-front">
                        <span>YOUR OWN WORDS</span>
                        <i>carve out</i>
                        <p>为重要的事，腾出一点时间。</p>
                        <div>READING　·　LISTENING　·　WRITING</div>
                      </div>
                    </div>
                  </section>
                  <div className="section-bar">
                    <div className="type-tabs">
                      <button
                        className={!type ? "selected" : ""}
                        onClick={() => setType("")}
                      >
                        All
                      </button>
                      {sourceTypes.map((t) => (
                        <button
                          key={t}
                          className={type === t ? "selected" : ""}
                          onClick={() => setType(t)}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={archived}
                        onChange={(e) => setArchived(e.target.checked)}
                      />
                      查看归档来源
                    </label>
                  </div>
                  <div className="section-bar">
                    <h2>
                      我的来源{" "}
                      <span className="subtle-count">{sourceList.length}</span>
                    </h2>
                    <span className="muted">最近更新优先</span>
                  </div>
                  {sourceList.length ? (
                    <div className="source-grid">
                      {sourceList.map((s) => (
                        <article className="source-card" key={s.id}>
                          <button
                            className="source-main"
                            onClick={() => {
                              setQuery("");
                              navigate(`source/${s.id}`);
                            }}
                          >
                            <div
                              className={`source-icon ${s.type.toLowerCase()}`}
                              aria-hidden="true"
                            >
                              {symbols[s.type]}
                            </div>
                            <span className="eyebrow">{s.type}</span>
                            <h3>{s.title}</h3>
                            <p>{s.author || s.date || "你的真实语料"}</p>
                            <div className="source-card-footer">
                              <span>{s.expressionCount} 个表达</span>
                              <span>↗</span>
                            </div>
                          </button>
                          <button
                            className="source-edit text-button"
                            aria-label={`编辑来源 ${s.title}`}
                            onClick={() => setSourceModal(s)}
                          >
                            编辑
                          </button>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <Empty title="从一个来源开始">
                      <p>添加正在读的书、听的播客，或自己的写作。</p>
                      <button
                        className="secondary"
                        onClick={() => setSourceModal("new")}
                      >
                        ＋ 新建来源
                      </button>
                    </Empty>
                  )}
                </>
              )}
              {view === "inbox" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        CAPTURE NOW, ORGANIZE LATER
                      </span>
                      <h1>
                        Inbox{" "}
                        <span className="heading-translation">收件箱</span>
                      </h1>
                      <p>先保留，再决定。不是每一个表达都需要主动掌握。</p>
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={showIgnored}
                        onChange={(e) => setShowIgnored(e.target.checked)}
                      />
                      查看已忽略
                    </label>
                  </div>
                  <div className="type-tabs">
                    <button
                      className={!type ? "selected" : ""}
                      onClick={() => setType("")}
                    >
                      All
                    </button>
                    {sourceTypes.map((t) => (
                      <button
                        key={t}
                        className={type === t ? "selected" : ""}
                        onClick={() => setType(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  {drafts.filter(
                    (d) =>
                      d.state === (showIgnored ? "ignored" : "pending") &&
                      (!type || d.data.sourceType === type),
                  ).length ? (
                    <div className="draft-list">
                      {drafts
                        .filter(
                          (d) =>
                            d.state === (showIgnored ? "ignored" : "pending") &&
                            (!type || d.data.sourceType === type),
                        )
                        .map((d) => (
                          <button
                            className="draft-card"
                            key={d.id}
                            onClick={() => navigate(`draft/${d.id}`)}
                          >
                            <div className="draft-icon" aria-hidden="true">
                              {symbols[d.data.sourceType]}
                            </div>
                            <div>
                              <span className="eyebrow">
                                {d.data.sourceType} ·{" "}
                                {sources.find((s) => s.id === d.data.sourceId)
                                  ?.title || "待补充来源"}
                              </span>
                              <h3 className="serif">{d.data.term}</h3>
                              <p>
                                {d.data.sentence ||
                                  "还没有原句，整理时可以补上。"}
                              </p>
                            </div>
                            <small>{displayDate(d.createdAt)}　→</small>
                          </button>
                        ))}
                    </div>
                  ) : (
                    <Empty
                      title={showIgnored ? "没有忽略的记录" : "收件箱很清爽"}
                    >
                      <p>下一次遇见好表达时，把它留在这里。</p>
                    </Empty>
                  )}
                </>
              )}
              {view.startsWith("draft/") && draft && (
                <DraftEditor
                  key={draft.id}
                  draft={draft}
                  sources={sources}
                  onDirty={onDirty}
                  onSourceCreated={sourceAdded}
                  onDone={(id) => {
                    setNotice(id ? "已保存到表达库。" : "草稿状态已更新。");
                    refresh();
                    navigate(id ? `expression/${id}` : "inbox");
                  }}
                />
              )}
              {(view === "search" || view.startsWith("source/")) && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        {activeSource?.type || "FIND YOUR OWN WORDS"}
                      </span>
                      <h1>
                        {activeSource?.title || "Search"}{" "}
                        {!activeSource && (
                          <span className="heading-translation">搜索</span>
                        )}
                      </h1>
                      <p>
                        {activeSource
                          ? "这个来源留下的表达与真实语境。"
                          : "找回一个表达，也找回第一次遇见它的地方。"}
                      </p>
                    </div>
                    {activeSource && (
                      <div className="actions wrap">
                        {activeSource.type === "Reading" &&
                          activeSource.lifecycle === "active" && (
                            <button
                              onClick={() =>
                                navigate(`flashcards/${activeSource.id}`)
                              }
                            >
                              翻本书闪卡
                            </button>
                          )}
                        <button
                          className="secondary"
                          onClick={() => setCapture(true)}
                        >
                          ＋ 从这里记录
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="search-toolbar">
                    <FieldSearch query={query} setQuery={setQuery} />
                    <select
                      aria-label="筛选来源类型"
                      value={type}
                      onChange={(e) => setType(e.target.value)}
                    >
                      <option value="">所有来源</option>
                      {sourceTypes.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                    <select
                      aria-label="筛选学习优先级"
                      value={priority}
                      onChange={(e) => setPriority(e.target.value)}
                    >
                      <option value="">所有优先级</option>
                      {["P1", "P2", "P3"].map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                  <div className="section-bar">
                    <span className="muted">
                      {loadedListKey === listKey
                        ? `${expressions.length} 个表达`
                        : "正在筛选…"}
                    </span>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={archived}
                        onChange={(e) => setArchived(e.target.checked)}
                      />
                      包含归档表达
                    </label>
                  </div>
                  {loadedListKey === listKey ? (
                    cards(expressions)
                  ) : (
                    <p role="status">正在读取表达列表…</p>
                  )}
                </>
              )}
              {view.startsWith("expression/") && detail?.id === currentId && (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="actions">
                        <span
                          className={`badge ${detail.priority.toLowerCase()}`}
                        >
                          {detail.priority}
                        </span>
                        <span className="eyebrow">{detail.type}</span>
                      </div>
                      <h1 className="expression-title serif">{detail.term}</h1>
                      <p className="meaning">{detail.meaning}</p>
                      {detail.alternative && (
                        <p>简单替换：{detail.alternative}</p>
                      )}
                    </div>
                  </div>
                  <section aria-label="原文与出处" className="detail-contexts">
                    <div className="section-bar">
                      <h2>原文与出处</h2>
                      <span className="muted">最近记录的有原句语境</span>
                    </div>
                    {primaryContext ? (
                      <ContextCard
                        context={primaryContext}
                        term={detail.term}
                      />
                    ) : (
                      <p className="panel muted">
                        尚未提供原句，可在下方“编辑语境 /
                        归属”中补充。学习改写和改进句不作为原文。
                      </p>
                    )}
                  </section>
                  {otherContexts.length > 0 && (
                    <section
                      aria-label="其他真实接触"
                      className="detail-contexts"
                    >
                      <div className="section-bar">
                        <h2>其他真实接触</h2>
                        <span className="muted">保留每次接触的语境</span>
                      </div>
                      <div className="timeline">
                        {otherContexts.map((c) => (
                          <ContextCard
                            context={c}
                            term={detail.term}
                            key={c.id}
                          />
                        ))}
                      </div>
                    </section>
                  )}
                  <button
                    className="secondary"
                    onClick={() => setCapture(true)}
                  >
                    ＋ 再次记录
                  </button>
                  <ReviewDetail expression={detail} />
                  {detail.lifecycle !== "deleted" ? (
                    supportingReady ? (
                      <Maintenance
                        expression={detail}
                        sources={sources}
                        onDirty={onDirty}
                        onDone={(id) => {
                          setNotice("已保存维护操作。");
                          refresh();
                          if (id === detail.id)
                            navigate(`expression/${id}`, browse);
                          else navigate(browse?.origin || "search", browse);
                        }}
                      />
                    ) : (
                      <section className="panel" role="status">
                        {error
                          ? "来源信息读取失败，请重试后编辑。"
                          : "正在读取来源信息，稍后可编辑…"}
                      </section>
                    )
                  ) : (
                    <section className="panel">
                      <p>此表达已在回收站，请到设置恢复。</p>
                      <button onClick={() => navigate("settings")}>
                        打开回收站
                      </button>
                    </section>
                  )}
                  <div className="stats-row">
                    {[
                      ["Seen · 遇见", detail.seen],
                      ["Used · 自主使用", detail.used],
                      ["Contexts · 语境", detail.contextCount],
                      ["Sources · 来源", detail.sourceCount],
                    ].map(([label, count]) => (
                      <div key={label}>
                        <strong>{count}</strong>
                        <span>{label}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {view === "review" && <ReviewPage sources={sources} />}
              {view.startsWith("flashcards/") && (
                <BookFlashcardPage
                  key={view}
                  sourceId={view.slice("flashcards/".length)}
                  onBack={() =>
                    navigate(`source/${view.slice("flashcards/".length)}`)
                  }
                />
              )}
              {view === "import" && (
                <ExcelImporter
                  sources={sources}
                  onDirty={onDirty}
                  onDone={(id, priority) => {
                    setQuery("");
                    setPriority(priority);
                    refresh();
                    navigate(`source/${id}`);
                  }}
                />
              )}
              {view === "settings" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        {cloud ? "PRIVATE WORKSPACE" : "LOCAL WORKSPACE"}
                      </span>
                      <h1>{cloud ? "云端工作空间" : "本地工作空间"}</h1>
                    </div>
                  </div>
                  <section className="panel settings-panel">
                    <h2>
                      {cloud
                        ? "学习数据保存在应用服务器"
                        : "数据保存在这台 Mac"}
                    </h2>
                    <p>
                      {cloud
                        ? "使用服务器持久数据卷；手机、iPad 和 Mac 访问同一份学习库。"
                        : "默认位置：项目目录 / data / readwords.sqlite"}
                    </p>
                    <p>
                      {cloud
                        ? "已启用私有邮箱登录。请确认服务器自动备份已配置，并定期演练恢复。"
                        : "停止服务后数据仍保留。本地模式无需登录，没有自动云端副本。"}
                    </p>

                    <p className="muted">
                      当前阶段：Source → 手动采集 → Inbox → 保存 → 搜索详情。
                    </p>
                  </section>
                  <BackupSettings />
                  <Trash
                    key={revision}
                    onDone={(id) => {
                      refresh();
                      navigate(`expression/${id}`);
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
        <footer className="workspace-footer">
          READWORDS{" "}
          <span>Context before definition. One expression at a time.</span>
        </footer>
      </main>
      {mergeSource && (
        <SourceMerge
          sources={sources}
          initial={mergeSource === "choose" ? undefined : mergeSource}
          onClose={() => setMergeSource(null)}
          onDone={() => {
            setMergeSource(null);
            setNotice(
              "来源合并完成，原来源已归档；操作前快照可在备份与恢复下载。",
            );
            refresh();
            navigate("library");
          }}
        />
      )}
      {sourceModal && (
        <Modal
          title={sourceModal === "new" ? "新建语料来源" : "编辑来源"}
          onClose={() => setSourceModal(null)}
        >
          <SourceForm
            source={sourceModal === "new" ? undefined : sourceModal}
            onCancel={() => setSourceModal(null)}
            onSaved={() => {
              setSourceModal(null);
              setNotice("来源已保存。");
              refresh();
            }}
          />
          {sourceModal !== "new" && sourceModal.lifecycle === "active" && (
            <button
              className="secondary"
              onClick={() => {
                setMergeSource(sourceModal);
                setSourceModal(null);
              }}
            >
              将此来源合并到…
            </button>
          )}
          {sourceModal !== "new" && (
            <button
              className="text-button archive-button"
              onClick={async () => {
                try {
                  await api(`sources/${sourceModal.id}`, "PATCH", {
                    data: sourceModal,
                    version: sourceModal.version,
                    lifecycle:
                      sourceModal.lifecycle === "active"
                        ? "archived"
                        : "active",
                  });
                  setSourceModal(null);
                  refresh();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {sourceModal.lifecycle === "active"
                ? "归档此来源（保留表达与语境）"
                : "恢复此来源"}
            </button>
          )}
        </Modal>
      )}
      {capture && (
        <Capture
          sources={sources}
          initialSource={
            activeSource?.lifecycle === "active" ? activeSource : undefined
          }
          onClose={() => setCapture(false)}
          onSourceCreated={sourceAdded}
          onSaved={(d) => {
            setCapture(false);
            setNotice("已加入 Inbox。");
            navigate(`draft/${d.id}`);
            refresh();
          }}
        />
      )}
    </div>
  );
}
function FieldSearch({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (q: string) => void;
}) {
  return (
    <label className="search-input">
      <span aria-hidden="true">⌕</span>
      <input
        aria-label="搜索表达、释义、原句或来源"
        placeholder="搜索表达、释义、原句或来源…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <button
          className="icon-button"
          aria-label="清空搜索"
          onClick={() => setQuery("")}
        >
          ×
        </button>
      )}
    </label>
  );
}
