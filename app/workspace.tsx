"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, displayDate } from "@/lib/client";
import {
  sourceTypes,
  reasonLabels,
  eventLabels,
  type Source,
  type Draft,
  type Expression,
} from "@/lib/contracts";
import { Capture, Empty, ErrorBox, Modal, SourceForm } from "./components";
import DraftEditor from "./draft-editor";
import Maintenance, { Trash } from "./maintenance";
import ReviewPage, { ReviewDetail } from "./review";
import BackupSettings from "./backup-settings";
import ExcelImporter from "./excel-importer";

const symbols: Record<string, string> = {
  Reading: "▤",
  Listening: "◉",
  Writing: "✎",
  Manual: "✧",
};
export default function Workspace() {
  const [view, setView] = useState("library");
  const [sources, setSources] = useState<Source[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [expressions, setExpressions] = useState<Expression[]>([]);
  const [detail, setDetail] = useState<Expression | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [archived, setArchived] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [capture, setCapture] = useState(false);
  const [sourceModal, setSourceModal] = useState<Source | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const dirty = useRef(false);
  const onDirty = useCallback((v: boolean) => {
    dirty.current = v;
  }, []);
  const refresh = () => setRevision((r) => r + 1);
  const navigate = (next: string) => {
    if (
      dirty.current &&
      !window.confirm("草稿尚未保存，确定离开？可先保存草稿或复制当前输入。")
    )
      return;
    dirty.current = false;
    window.location.hash = next;
  };
  useEffect(() => {
    let previous = window.location.hash || "#library";
    const read = () => {
      if (
        dirty.current &&
        !window.confirm("草稿尚未保存，确定离开？可先保存或复制当前输入。")
      ) {
        window.history.replaceState(null, "", previous);
        return;
      }
      dirty.current = false;
      previous = window.location.hash || "#library";
      setView(previous.slice(1));
      setType("");
      setError("");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setDetail(null);
    setDraft(null);
    const load = async () => {
      const [s, d] = await Promise.all([
        api<Source[]>("sources"),
        api<Draft[]>("drafts"),
      ]);
      if (!active) return;
      setSources(s);
      setDrafts(d);
      if (view.startsWith("draft/")) {
        const item = await api<Draft>(`drafts/${view.split("/")[1]}`);
        if (active) setDraft(item);
      }
      if (view.startsWith("expression/")) {
        const item = await api<Expression>(`expressions/${view.split("/")[1]}`);
        if (active) setDetail(item);
      }
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
    const params = new URLSearchParams({
      q: query,
      type,
      priority,
      archived: archived ? "1" : "0",
      sourceId: view.startsWith("source/") ? view.split("/")[1] : "",
    });
    const timer = setTimeout(
      () =>
        api<Expression[]>(`expressions?${params}`)
          .then((result) => {
            if (active) setExpressions(result);
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
  }, [view, query, type, priority, archived, revision]);
  const sourceAdded = (source: Source) =>
    setSources((s) => [source, ...s.filter((v) => v.id !== source.id)]);
  const activeSource = view.startsWith("source/")
    ? sources.find((s) => s.id === view.split("/")[1])
    : undefined;
  const section = view.split("/")[0];
  const navActive =
    section === "source" || section === "import"
      ? "library"
      : section === "draft"
        ? "inbox"
        : section === "expression"
          ? "search"
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
            onClick={() => navigate(`expression/${e.id}`)}
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
          本地工作空间<span>⚙</span>
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
          {loading ? (
            <div className="empty" role="status">
              正在读取本地工作空间…
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
                      <button
                        className="secondary"
                        onClick={() => setCapture(true)}
                      >
                        ＋ 从这里记录
                      </button>
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
                    <span className="muted">{expressions.length} 个表达</span>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={archived}
                        onChange={(e) => setArchived(e.target.checked)}
                      />
                      包含归档表达
                    </label>
                  </div>
                  {cards(expressions)}
                </>
              )}
              {view.startsWith("expression/") && detail && (
                <>
                  <button
                    className="text-button back"
                    onClick={() => navigate("search")}
                  >
                    ← 返回表达库
                  </button>
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
                    <button
                      className="secondary"
                      onClick={() => setCapture(true)}
                    >
                      ＋ 再次记录
                    </button>
                  </div>
                  <ReviewDetail expression={detail} />
                  {detail.lifecycle !== "deleted" ? (
                    <Maintenance
                      expression={detail}
                      sources={sources}
                      onDirty={onDirty}
                      onDone={(id) => {
                        setNotice("已保存维护操作。");
                        refresh();
                        navigate(id ? `expression/${id}` : "search");
                      }}
                    />
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
                  <div className="section-bar">
                    <h2>每一次真实接触</h2>
                    <span className="muted">次数来自你的记录</span>
                  </div>
                  <div className="timeline">
                    {detail.contexts.map((c) => (
                      <article className="context-card" key={c.id}>
                        <div className="section-bar">
                          <div>
                            <span
                              className={`tag ${c.sourceType.toLowerCase()}`}
                            >
                              {c.sourceType}
                            </span>
                            <strong>{c.sourceTitle}</strong>
                          </div>
                          <span className="muted">
                            {eventLabels[c.data.eventKind]}
                          </span>
                        </div>
                        <div className="context-position">
                          {[
                            c.data.chapter,
                            c.data.page ? `p. ${c.data.page}` : "",
                            c.data.timestamp,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "位置未提供"}
                          　·　
                          {c.data.occurredOn
                            ? `接触日期 ${c.data.occurredOn}`
                            : `记录于 ${displayDate(c.createdAt)}`}
                        </div>
                        {c.data.sentence ? (
                          <blockquote>{c.data.sentence}</blockquote>
                        ) : (
                          <p className="muted">未提供原句</p>
                        )}
                        <p>
                          <span className="muted">
                            {c.data.importMetadata
                              ? "英文语境释义　"
                              : "语境释义　"}
                          </span>
                          {c.data.meaning}
                        </p>
                        {c.data.importMetadata && (
                          <details className="import-provenance">
                            <summary>
                              Excel 导入信息 · {c.data.importMetadata.sheet} 第{" "}
                              {c.data.importMetadata.row} 行
                            </summary>
                            <p>文件：{c.data.importMetadata.fileName}</p>
                            <p>
                              {c.data.importMetadata.profile ===
                              "little-farm-v1"
                                ? "原表中文释义："
                                : "词典中文义项："}
                              {c.data.importMetadata.dictionaryChinese}
                            </p>
                            <p>
                              {c.data.importMetadata.profile ===
                              "little-farm-v1"
                                ? "核心英文释义："
                                : "词典英文解释："}
                              {c.data.importMetadata.dictionaryEnglish}
                            </p>
                            <p>
                              音标（原表记录）：
                              {c.data.importMetadata.ipa || "未提供"} · 词性：
                              {c.data.importMetadata.partOfSpeech}
                            </p>
                            {c.data.importMetadata.profile ===
                              "little-farm-v1" && (
                              <>
                                <p>
                                  原表来源标记 / 页码：
                                  {c.data.importMetadata.rawSourceLocation ||
                                    "未提供"}
                                </p>
                                <p>
                                  简单英文释义 / 学习改写：
                                  {c.data.importMetadata.simpleParaphrase ||
                                    "未提供"}
                                </p>
                                <p>
                                  原表片段按一行记录一次遇见，不按页码数量叠加。
                                </p>
                              </>
                            )}
                            {c.data.importMetadata.learningTarget && (
                              <p>
                                复习目标或搭配：
                                {c.data.importMetadata.learningTarget}
                              </p>
                            )}
                            <p>
                              {c.data.importMetadata.profile ===
                              "little-farm-v1"
                                ? "学习理由："
                                : "严格等级理由："}
                              {c.data.importMetadata.rationale}
                            </p>
                            <p>
                              原等级：
                              {c.data.importMetadata.originalPriority ||
                                "未提供"}
                              {c.data.importMetadata.bookCount && (
                                <>
                                  {" "}
                                  · 原表出现次数：
                                  {c.data.importMetadata.bookCount}（不重复计入
                                  Seen）
                                </>
                              )}
                            </p>
                            {c.data.importMetadata.priorityConflict && (
                              <p>其他明细含不同等级，本次仅导入严格 P1。</p>
                            )}
                            {c.data.importMetadata.excerpt && (
                              <p>上下文为原表节选，未补写。</p>
                            )}
                          </details>
                        )}
                        {c.data.eventKind === "output_corrected" && (
                          <div className="correction">
                            <p>
                              <span>原表达</span>
                              {c.data.originalExpression}
                            </p>
                            <p>
                              <span>改进表达</span>
                              {c.data.correctedExpression}
                            </p>
                            {c.data.correctedSentence && (
                              <blockquote>
                                {c.data.correctedSentence}
                              </blockquote>
                            )}
                          </div>
                        )}
                        {c.data.intendedMeaning && (
                          <p>想表达：{c.data.intendedMeaning}</p>
                        )}
                        {c.data.misheard && <p>误听：{c.data.misheard}</p>}
                        <footer className="context-reason">
                          <span>
                            Why saved · {reasonLabels[c.data.whySaved]}
                            {c.data.importMetadata ? "（导入默认）" : ""}
                          </span>
                          {c.data.note && <p>{c.data.note}</p>}
                        </footer>
                      </article>
                    ))}
                  </div>
                </>
              )}
              {view === "review" && <ReviewPage sources={sources} />}
              {view === "import" && (
                <ExcelImporter
                  sources={sources}
                  onDone={(id) => {
                    setQuery("");
                    setPriority("P1");
                    refresh();
                    navigate(`source/${id}`);
                  }}
                />
              )}
              {view === "settings" && (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">LOCAL WORKSPACE</span>
                      <h1>本地工作空间</h1>
                    </div>
                  </div>
                  <section className="panel settings-panel">
                    <h2>数据保存在这台 Mac</h2>
                    <p>默认位置：项目目录 / data / readwords.sqlite</p>
                    <p>
                      停止服务后数据仍保留。当前无账号、云端同步或自动外部请求。
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
