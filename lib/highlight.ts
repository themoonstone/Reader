export type TextPart = { text: string; highlight: boolean };
/** Literal Unicode-aware word boundaries; never interprets markup or guesses inflections. */
export function highlightParts(
  text: string,
  target: string,
  occurrence?: number,
  exact = false,
): TextPart[] {
  if (!target.trim()) return [{ text, highlight: false }];
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, exact ? "gu" : "giu");
  const matches = [...text.matchAll(regex)].filter((m) => {
    if (exact) return true;
    const start = m.index!,
      end = start + m[0].length;
    return (
      !(
        /[\p{L}\p{N}_]/u.test(m[0][0]) &&
        /[\p{L}\p{N}_]/u.test([...text.slice(0, start)].pop() || "")
      ) &&
      !(
        /[\p{L}\p{N}_]/u.test([...m[0]].pop() || "") &&
        /[\p{L}\p{N}_]/u.test(text.slice(end)[0] || "")
      )
    );
  });
  const chosen =
    occurrence === undefined
      ? matches
      : matches.slice(occurrence - 1, occurrence);
  const parts: TextPart[] = [];
  let offset = 0;
  for (const m of chosen) {
    if (m.index! > offset)
      parts.push({ text: text.slice(offset, m.index), highlight: false });
    parts.push({ text: m[0], highlight: true });
    offset = m.index! + m[0].length;
  }
  if (offset < text.length || !parts.length)
    parts.push({ text: text.slice(offset), highlight: false });
  return parts;
}
