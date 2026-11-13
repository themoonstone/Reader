"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { BookFlashcards } from "@/lib/flashcards";
import { ErrorBox, Field } from "./components";
import Flashcard from "./flashcard";

export default function BookFlashcardPage({
  sourceId,
  onBack,
}: {
  sourceId: string;
  onBack: () => void;
}) {
  const [catalog, setCatalog] = useState<BookFlashcards>();
  const [chapter, setChapter] = useState("all");
  const [priority, setPriority] = useState("");
  const [limit, setLimit] = useState("10");
  const [retry, setRetry] = useState(0);
  const [round, setRound] = useState<BookFlashcards>();
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  const pending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const answer = useRef<HTMLDivElement>(null);
  const setup = useRef<HTMLHeadingElement>(null);
  const restoreSetupFocus = useRef(false);
  const route = `sources/${encodeURIComponent(sourceId)}/flashcards`;
  useEffect(() => {
    const request = ++version.current;
    api<BookFlashcards>(route).then(
      (data) => {
        if (request === version.current) setCatalog(data);
      },
      (e: Error) => {
        if (request === version.current) setError(e.message);
      },
    );
    return () => {
      version.current++;
    };
  }, [route, retry]);
  const card = round?.cards[index];
  useEffect(() => {
    if (card) heading.current?.focus();
  }, [card]);
  useEffect(() => {
    if (revealed) answer.current?.focus({ preventScroll: true });
  }, [revealed]);
  useEffect(() => {
    if (!round && restoreSetupFocus.current) {
      restoreSetupFocus.current = false;
      setup.current?.focus();
    }
  }, [round]);

  async function start() {
    if (!catalog || pending.current) return;
    pending.current = true;
    const request = ++version.current;
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ priority, limit });
    if (chapter !== "all") params.set("chapter", chapter.slice(1));
    try {
      const data = await api<BookFlashcards>(`${route}?${params}`);
      if (request !== version.current) return;
      setCatalog(data);
      if (!data.cards.length) {
        if (chapter !== "all" && !data.chapters.includes(chapter.slice(1)))
          setChapter("all");
        setError("所选章节和等级没有可翻的闪卡，请调整范围。");
        return;
      }
      setIndex(0);
      setRevealed(false);
      setRound(data);
    } catch (e) {
      if (request === version.current) setError((e as Error).message);
    } finally {
      if (request === version.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  function move(next: number) {
    setRevealed(false);
    setIndex(next);
  }
  function finish() {
    restoreSetupFocus.current = true;
    setRound(undefined);
    setRevealed(false);
  }

  return (
    <section className="book-flashcards" aria-label="书籍闪卡">
      <div className="section-bar">
        <button className="text-button" onClick={onBack}>
          ← 返回原书
        </button>
        {round && (
          <span role="status">
            {index + 1} / {round.cards.length}
          </span>
        )}
      </div>
      <h1>{catalog?.title || "书籍闪卡"}</h1>
      <ErrorBox error={error} />
      {!catalog &&
        (error ? (
          <button
            className="secondary"
            onClick={() => {
              setError("");
              setRetry((n) => n + 1);
            }}
          >
            重新读取
          </button>
        ) : (
          <p role="status">正在读取闪卡范围…</p>
        ))}
      {catalog && !round && (
        <div className="panel">
          <h2 ref={setup} tabIndex={-1}>
            翻本书闪卡
          </h2>
          <p>随手翻看。不会改变收藏等级、加入复习池或保存复习进度。</p>
          <div className="form-grid">
            <Field label="闪卡章节">
              <select
                value={chapter}
                disabled={busy}
                onChange={(e) => {
                  setChapter(e.target.value);
                  setError("");
                }}
              >
                <option value="all">全部章节</option>
                {catalog.chapters.map((c) => (
                  <option key={c} value={`:${c}`}>
                    {c || "未标章节"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="闪卡等级">
              <select
                value={priority}
                disabled={busy}
                onChange={(e) => {
                  setPriority(e.target.value);
                  setError("");
                }}
              >
                <option value="">全部等级</option>
                {["P1", "P2", "P3"].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
            <Field label="本轮最多几张">
              <select
                value={limit}
                disabled={busy}
                onChange={(e) => setLimit(e.target.value)}
              >
                {[5, 10, 20].map((n) => (
                  <option key={n} value={n}>
                    {n} 张
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button
            disabled={busy || !catalog.chapters.length}
            onClick={() => void start()}
          >
            {busy ? "正在选卡…" : "开始翻卡"}
          </button>
          {!catalog.chapters.length && <p>本书还没有可翻的表达。</p>}
        </div>
      )}
      {round && card && (
        <div
          className="book-flashcard-round"
          onKeyDown={(e) => {
            if (e.key === " " && e.target === heading.current && !revealed) {
              e.preventDefault();
              setRevealed(true);
            }
          }}
        >
          <p className="muted">
            {chapter === "all" ? "全部章节" : chapter.slice(1) || "未标章节"} ·{" "}
            {priority || "全部等级"}
          </p>
          <Flashcard
            term={card.term}
            sentence={card.sentence}
            surface={card.surface}
            occurrence={card.occurrence}
            headingRef={heading}
          >
            {revealed && (
              <div
                className="review-answer"
                ref={answer}
                tabIndex={-1}
                aria-label="闪卡答案"
              >
                <h3>表达义项</h3>
                <p>{card.meaning || "未填写表达义项"}</p>
                {card.contextMeaning &&
                  card.contextMeaning !== card.meaning && (
                    <>
                      <h3>
                        {card.contextLanguage === "en"
                          ? "英文语境释义"
                          : "语境释义"}
                      </h3>
                      <p>{card.contextMeaning}</p>
                    </>
                  )}
                <p className="muted">
                  {[round.title, card.chapter, card.page && `p. ${card.page}`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                {card.verification && <p>原文状态：{card.verification}</p>}
                {(card.example || card.note) && (
                  <details>
                    <summary>补充例句和备注</summary>
                    {card.example && (
                      <>
                        <h3>补充例句（非原文）</h3>
                        <p lang="en">{card.example}</p>
                        <p>{card.exampleChinese}</p>
                        {card.exampleSource && (
                          <p>例句来源：{card.exampleSource}</p>
                        )}
                      </>
                    )}
                    {card.note && <p className="flashcard-note">{card.note}</p>}
                  </details>
                )}
              </div>
            )}
          </Flashcard>
          <div className="flashcard-controls">
            <button
              className="secondary"
              disabled={index === 0}
              onClick={() => move(index - 1)}
            >
              上一张
            </button>
            {!revealed && (
              <button onClick={() => setRevealed(true)}>显示释义</button>
            )}
            <button
              className={revealed ? "" : "secondary"}
              onClick={() =>
                index + 1 < round.cards.length ? move(index + 1) : finish()
              }
            >
              {index + 1 === round.cards.length
                ? revealed
                  ? "结束本轮"
                  : "跳过并结束"
                : revealed
                  ? "下一张"
                  : "跳过"}
            </button>
            {index + 1 < round.cards.length && (
              <button className="text-button" onClick={finish}>
                结束本轮
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
