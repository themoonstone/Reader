import type { ReactNode, Ref } from "react";
import HighlightedText from "./highlighted-text";

export default function Flashcard({
  term,
  sentence,
  surface,
  occurrence,
  headingRef,
  children,
  label = "当前闪卡",
}: {
  term: string;
  sentence: string;
  surface?: string;
  occurrence?: number;
  headingRef?: Ref<HTMLHeadingElement>;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <article className="flashcard" aria-label={label}>
      <h2 ref={headingRef} tabIndex={-1} lang="en">
        {term}
      </h2>
      {sentence.trim() ? (
        <blockquote lang="en">
          <HighlightedText
            text={sentence}
            term={term}
            surface={surface}
            occurrence={occurrence}
          />
        </blockquote>
      ) : (
        <p className="muted">这条记录没有原句，可揭晓释义。</p>
      )}
      {children}
    </article>
  );
}
