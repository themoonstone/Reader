import type { DraftInput } from "./contracts";
import { AppError, type Store } from "./store";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { makeCloze, type Cloze } from "./cloze";
import { choiceForm, clozeDistractors } from "./cloze-choices";
import { selectMatchCandidates, type BookMatching } from "./book-matching";

export type BookCard = {
  id: string;
  term: string;
  sentence: string;
  sentenceTranslation?: string;
  chineseHint?: string;
  surface: string;
  occurrence?: number;
  meaning: string;
  contextMeaning: string;
  contextLanguage: "en" | "user";
  chapter: string;
  page: string;
  verification?: string;
  example?: string;
  exampleChinese?: string;
  exampleSource?: string;
  note: string;
  cloze?: Cloze & { options?: string[] };
};

const scope = z.object({
  chapter: z.string().max(200).nullable(),
  priority: z.enum(["", "P1", "P2", "P3"]),
});
const optionsSchema = z.discriminatedUnion("mode", [
  scope.extend({
    mode: z.enum(["flashcard", "cloze", "cloze-choice"]),
    limit: z.enum(["5", "10", "20"]).nullable(),
  }),
  scope.extend({ mode: z.literal("match"), limit: z.enum(["4", "5", "6"]) }),
]);

function sample<T>(entries: T[], limit: number) {
  const size = Math.min(entries.length, limit);
  // Sample without replacement, so a short round can reach beyond the first page.
  if (size < entries.length)
    for (let i = 0; i < size; i++) {
      const j = randomInt(i, entries.length);
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }
  return entries.slice(0, size);
}

function shuffle<T>(entries: T[]) {
  for (let i = entries.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  return entries;
}

export function bookFlashcards(
  db: Store,
  sourceId: string,
  params: URLSearchParams,
) {
  const source = db.getSource(z.uuid().parse(sourceId));
  if (source.type !== "Reading" || source.lifecycle !== "active")
    throw new AppError("此阅读来源不可用，请返回来源库", 404, "NOT_FOUND");
  const { chapter, priority, limit, mode } = optionsSchema.parse({
    chapter: params.get("chapter"),
    priority: params.get("priority") ?? "",
    limit: params.get("limit"),
    mode: params.get("mode") ?? "flashcard",
  });
  const rows = db.all(
    `SELECT e.id, e.term, e.meaning, e.priority, c.data
     FROM contexts c JOIN expressions e ON e.id=c.expression_id
     WHERE c.source_id=? AND c.lifecycle='active' AND e.lifecycle='active'
     ORDER BY c.created_at DESC, c.id`,
    source.id,
  );
  const chapters = new Set<string>();
  const choiceMode = mode === "cloze-choice";
  const gapMode = choiceMode || mode === "cloze";
  const bank = new Map<string, NonNullable<ReturnType<typeof choiceForm>>[]>();
  const chosen = new Map<
    string,
    {
      data: DraftInput;
      term: string;
      meaning: string;
      rank: number;
      cloze?: BookCard["cloze"];
    }
  >();
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as DraftInput;
    chapters.add(data.chapter);
    if (!limit) continue;
    const inScope =
      (chapter === null || chapter === data.chapter) &&
      (!priority || priority === row.priority);
    if (!inScope && !choiceMode) continue;
    const status = data.importMetadata?.verificationStatus;
    const term = String(row.term);
    const id = String(row.id);
    const meaning = String(row.meaning);
    const cloze =
      gapMode && status !== "待补充"
        ? makeCloze(
            data.sentence,
            term,
            data.targetSurface,
            data.importMetadata?.highlightOccurrence,
          )
        : undefined;
    if (choiceMode && cloze) {
      const form = choiceForm({
        id,
        term,
        meaning,
        chapter: data.chapter,
        cloze,
      });
      if (form) {
        const group = bank.get(form.group) ?? [];
        group.push(form);
        bank.set(form.group, group);
      }
    }
    if (!inScope) continue;
    const sentenceRank = !data.sentence.trim()
      ? 0
      : status === "已核对完整句" || status === "已核对节选"
        ? 2
        : 1;
    const rank = sentenceRank + (cloze ? 3 : 0);
    if ((chosen.get(id)?.rank ?? -1) < rank)
      chosen.set(id, {
        data,
        term,
        meaning,
        rank,
        cloze,
      });
  }
  const entries = [...chosen.entries()];
  const size = Number(limit);
  const sortedChapters = [...chapters].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  if (mode === "match") {
    const candidates = entries.map(([id, { term, meaning }]) => ({
      id,
      term,
      meaning,
    }));
    let selected = selectMatchCandidates(shuffle(candidates), size);
    // A conflicting candidate can block multiple options. Try a few orders
    // when the first pass cannot fill the requested round.
    for (let i = 0; i < 4 && selected.length < size; i++) {
      const alternative = selectMatchCandidates(shuffle(candidates), size);
      if (alternative.length > selected.length) selected = alternative;
    }
    let matching: BookMatching | undefined;
    if (selected.length >= 4) {
      const english = selected.map(({ id, term }) => ({ id, text: term }));
      const chinese = shuffle(
        selected.map(({ id, meaning }) => ({ id, text: meaning })),
      );
      if (chinese.every((option, i) => option.id === english[i].id))
        chinese.push(chinese.shift()!);
      matching = { english, chinese };
    }
    return {
      title: source.title,
      chapters: sortedChapters,
      cards: [] as BookCard[],
      matching,
    };
  }
  let selected = entries;
  if (choiceMode) {
    for (const group of bank.values()) shuffle(group);
    const questions: typeof entries = [],
      fallback: typeof entries = [];
    for (const entry of shuffle(entries)) {
      const [id, card] = entry;
      const {
        term,
        meaning,
        cloze,
        data: { chapter },
      } = card;
      const form = cloze && choiceForm({ id, term, meaning, chapter, cloze });
      const group = form && (bank.get(form.group) ?? []);
      const distractors =
        form &&
        group &&
        (clozeDistractors(
          form,
          group.filter((candidate) => candidate.chapter === chapter),
        ) ??
          clozeDistractors(form, group));
      if (cloze && distractors) {
        card.cloze = {
          ...cloze,
          options: shuffle([cloze.answer, ...distractors]),
        };
        questions.push(entry);
        if (questions.length === size) break;
      } else {
        card.cloze = undefined;
        fallback.push(entry);
      }
    }
    selected = questions.concat(fallback.slice(0, size - questions.length));
  } else if (gapMode) {
    const questions = sample(
      entries.filter(([, entry]) => entry.cloze),
      size,
    );
    selected = questions.concat(
      sample(
        entries.filter(([, entry]) => !entry.cloze),
        size - questions.length,
      ),
    );
  } else {
    selected = sample(entries, size);
  }
  const cards: BookCard[] = selected.map(
    ([id, { data, term, meaning, cloze }]) => {
      const meta = data.importMetadata;
      return {
        id,
        term,
        meaning,
        sentence: data.sentence,
        sentenceTranslation: data.sentence.trim()
          ? data.sentenceTranslation
          : undefined,
        chineseHint: data.sentence.trim() ? data.chineseHint : undefined,
        surface: data.targetSurface,
        occurrence: meta?.highlightOccurrence,
        contextMeaning: data.meaning,
        contextLanguage:
          meta && data.meaning === meta.contextMeaningEnglish ? "en" : "user",
        chapter: data.chapter,
        page: data.page,
        verification: meta?.verificationStatus,
        example: meta?.example,
        exampleChinese: meta?.exampleChinese,
        exampleSource: meta?.exampleSource,
        note: data.note,
        cloze,
      };
    },
  );
  return {
    title: source.title,
    chapters: sortedChapters,
    cards,
  };
}

export type BookFlashcards = ReturnType<typeof bookFlashcards>;
