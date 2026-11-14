import { normalizeClozeAnswer, type Cloze } from "./cloze";
import { highlightParts } from "./highlight";

type FormInput = {
  id: string;
  term: string;
  meaning: string;
  chapter: string;
  cloze: Cloze;
};

function words(text: string) {
  return normalizeClozeAnswer(text).match(/[a-z]+(?:['-][a-z]+)*/g) ?? [];
}

// Use the form and its attested surroundings. Unknown forms stay out of the
// choice bank instead of being treated as interchangeable with every word.
function shape({ cloze, term }: FormInput) {
  const form = words(cloze.answer);
  const head = form[0];
  if (
    !head ||
    /^(am|is|are|was|were|be|been|being|has|have|had|do|does|did)$/.test(
      head,
    ) ||
    !/^[a-z]+(?:[' -][a-z]+)*$/i.test(normalizeClozeAnswer(cloze.answer))
  )
    return;
  const previous = words(cloze.before).at(-1);
  const base = words(term)[0];
  let role: string | undefined;
  if (
    previous &&
    /^(a|an|the|my|your|his|her|their|our|its|these|those)$/.test(previous) &&
    form.length === 1 &&
    /^\s*[.,!?;:”’"']|^\s+(?:and|or|of|who|which|that|to|into|in|on)\b/i.test(
      cloze.after,
    )
  ) {
    role =
      /^(these|those)$/.test(previous) || (head !== base && head.endsWith("s"))
        ? "plural noun"
        : "singular noun";
  } else if (head.endsWith("ing") && head !== base) role = "ing";
  else if (previous && /^(had|has|have)$/.test(previous) && head !== base)
    role = "participle";
  else if (head.endsWith("ed") && head !== base) role = "past";
  else if (
    previous &&
    /^(to|would|could|should|must|can|will|may|might|did|shall)$/.test(
      previous,
    ) &&
    head === base
  )
    role = "base verb";
  else if (form.length === 1 && /[a-z]{3}ly$/.test(head) && head === base)
    role = "adverb";
  else if (
    form.length === 1 &&
    previous &&
    /^(very|quite|rather|too|so|bit|being|be|seems?|looks?)$/.test(previous) &&
    head === base
  )
    role = "adjective";
  return role && `${role}:${Math.min(form.length, 3)}`;
}

function glossFragments(meaning: string) {
  const runs = meaning.match(/\p{Script=Han}+/gu) ?? [];
  return new Set(
    runs.flatMap((run) => {
      const chars = [...run];
      return chars.length < 2
        ? [run]
        : chars.slice(1).map((c, i) => chars[i] + c);
    }),
  );
}

export function choiceForm(input: FormInput) {
  const group = shape(input);
  const gloss = glossFragments(input.meaning);
  if (!group || !gloss.size) return;
  const answer = normalizeClozeAnswer(input.cloze.answer);
  const term = normalizeClozeAnswer(input.term);
  const keywords = [...words(answer), ...words(term)]
    .filter(
      (word) =>
        word.length > 3 &&
        !/^(that|this|with|from|into|over|some|ones|your|their|have|been)$/.test(
          word,
        ),
    )
    .map((word) => word.replace(/(?:ing|ed|s)$/u, "").replace(/e$/u, ""));
  return {
    ...input,
    group,
    gloss,
    answer,
    normalizedTerm: term,
    head: words(answer)[0],
    keywords,
  };
}

type ChoiceForm = NonNullable<ReturnType<typeof choiceForm>>;

export function clozeDistractors(target: ChoiceForm, bank: ChoiceForm[]) {
  const surrounding = [target.cloze.before, target.cloze.after].map(
    normalizeClozeAnswer,
  );
  const article = words(target.cloze.before).at(-1);
  const used = [target];
  for (const candidate of bank) {
    if (
      candidate.group !== target.group ||
      used.some(
        (other) =>
          candidate.id === other.id ||
          candidate.answer === other.answer ||
          candidate.normalizedTerm === other.normalizedTerm ||
          candidate.head === other.head ||
          candidate.keywords.some((word) => other.keywords.includes(word)) ||
          [...candidate.gloss].some((part) => other.gloss.has(part)),
      ) ||
      surrounding.some((text) =>
        highlightParts(text, candidate.answer).some((part) => part.highlight),
      ) ||
      ((article === "a" || article === "an") &&
        /^[aeiou]/.test(candidate.answer) !== (article === "an"))
    )
      continue;
    used.push(candidate);
    if (used.length === 3)
      return used.slice(1).map((form) => form.cloze.answer);
  }
}
