"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BookMatching } from "@/lib/book-matching";

type Side = keyof BookMatching;
type Selection = { side: Side; id: string };

export default function BookMatchRound({
  board,
  scope,
  onFinish,
}: {
  board: BookMatching;
  scope: string;
  onFinish: () => void;
}) {
  const [selection, setSelection] = useState<Selection>();
  const [matched, setMatched] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const complete = matched.length === board.english.length;
  useEffect(() => {
    heading.current?.focus();
  }, [complete]);

  function choose(side: Side, id: string) {
    if (matched.includes(id)) return;
    if (!selection || selection.side === side) {
      setSelection(
        selection?.id === id && selection.side === side
          ? undefined
          : { side, id },
      );
      setFeedback("");
    } else if (selection.id === id) {
      setMatched([...matched, id]);
      setSelection(undefined);
      setFeedback("配对成功。");
    } else {
      setSelection(undefined);
      setFeedback("这两个选项不匹配，请重新选择。");
    }
  }

  return (
    <section className="flashcard" aria-labelledby="book-match-heading">
      <p className="muted">{scope}</p>
      <h2 id="book-match-heading" ref={heading} tabIndex={-1}>
        {complete ? "本轮配对完成" : "英中配对"}
      </h2>
      <p role="status">
        已配对 {matched.length} / {board.english.length} 对。
        {!complete && feedback}
      </p>
      {!complete && (
        <>
          <p>选一个英文表达，再选对应的中文释义。也可以先选中文。</p>
          <div
            className="book-match-grid"
            style={{ "--match-pairs": board.english.length } as CSSProperties}
          >
            {(
              [
                ["english", "英文", "en"],
                ["chinese", "中文释义", "zh"],
              ] as const
            ).map(([side, label, lang]) => (
              <div
                className="book-match-column"
                key={side}
                role="group"
                aria-label={label}
              >
                <h3>{label}</h3>
                {board[side].map(({ id, text }) => {
                  const done = matched.includes(id);
                  return (
                    <button
                      key={id}
                      className="secondary"
                      type="button"
                      aria-pressed={
                        selection?.side === side && selection.id === id
                      }
                      aria-disabled={done}
                      aria-label={done ? `${text}（已配对）` : undefined}
                      tabIndex={done ? -1 : undefined}
                      onClick={() => choose(side, id)}
                    >
                      <span lang={lang}>{text}</span>
                      {done && <span aria-hidden="true"> ✓</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="book-match-actions">
        <button className={complete ? "" : "secondary"} onClick={onFinish}>
          {complete ? "重选范围" : "结束本轮"}
        </button>
      </div>
    </section>
  );
}
