export type MatchOption = { id: string; text: string };

export type BookMatching = {
  english: MatchOption[];
  chinese: MatchOption[];
};

type MatchCandidate = { id: string; term: string; meaning: string };

function normalize(text: string) {
  return text.normalize("NFKC").toLowerCase();
}

export function selectMatchCandidates(
  candidates: MatchCandidate[],
  limit: number,
) {
  const terms = new Set<string>();
  const glosses: string[] = [];
  const selected: MatchCandidate[] = [];
  for (const candidate of candidates) {
    const term = normalize(candidate.term).replace(/[^\p{L}\p{N}]+/gu, "");
    const parts = normalize(candidate.meaning)
      .replace(/\s+/gu, "")
      .split(/[^\p{L}\p{N}\p{M}]+/u)
      .filter((part) => /\p{Script=Han}/u.test(part));
    if (
      !/\p{Script=Latin}/u.test(term) ||
      !parts.length ||
      terms.has(term) ||
      parts.some((part) =>
        glosses.some((gloss) => gloss.includes(part) || part.includes(gloss)),
      )
    )
      continue;
    terms.add(term);
    glosses.push(...parts);
    selected.push(candidate);
    if (selected.length === limit) break;
  }
  return selected;
}
