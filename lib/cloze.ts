import { highlightParts } from "./highlight";

export function normalizeClozeAnswer(text: string) {
  return text
    .normalize("NFC")
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export type Cloze = { before: string; after: string; answer: string };

const wordStart = /^[\p{L}\p{M}\p{N}_]/u;
const wordEnd = /[\p{L}\p{M}\p{N}_]$/u;
const wordAtLeft = /[\p{L}\p{M}\p{N}_]['’\p{Pd}]?$/u;
const wordAtRight = /^['’\p{Pd}]?[\p{L}\p{M}\p{N}_]/u;

export function makeCloze(
  sentence: string,
  term: string,
  surface: string,
  occurrence?: number,
): Cloze | undefined {
  const parts = highlightParts(
    sentence,
    surface || term,
    surface ? (occurrence ?? 1) : undefined,
    Boolean(surface),
  );
  const index = parts.findIndex((part) => part.highlight);
  if (index < 0 || parts.slice(index + 1).some((part) => part.highlight))
    return;

  const answer = parts[index].text;
  const before = parts[index - 1]?.text ?? "";
  const after = parts[index + 1]?.text ?? "";
  // An explicit surface may highlight a substring in the detail display.
  // A blank must cover the whole form, with usable context outside it.
  if (
    !/[\p{L}\p{N}]/u.test(answer) ||
    !/[\p{L}\p{N}]/u.test(before + after) ||
    (wordAtLeft.test(before) && wordStart.test(answer)) ||
    (wordEnd.test(answer) && wordAtRight.test(after))
  )
    return;

  const leaks = [before, after].some((text) =>
    [answer, term].some((target) =>
      highlightParts(
        normalizeClozeAnswer(text),
        normalizeClozeAnswer(target),
      ).some((part) => part.highlight),
    ),
  );
  if (!leaks) return { before, after, answer };
}
