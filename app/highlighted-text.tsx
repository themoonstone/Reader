import { highlightParts } from "@/lib/highlight";
export default function HighlightedText({
  text,
  term,
  surface = "",
  occurrence,
}: {
  text: string;
  term: string;
  surface?: string;
  occurrence?: number;
}) {
  return (
    <>
      {highlightParts(
        text,
        surface || term,
        surface ? (occurrence ?? 1) : undefined,
        Boolean(surface),
      ).map((part, i) =>
        part.highlight ? (
          <mark className="learning-target" key={i}>
            <strong>{part.text}</strong>
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
