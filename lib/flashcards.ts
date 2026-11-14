import type { DraftInput } from "./contracts";
import { AppError, type Store } from "./store";
import { z } from "zod";
import { randomInt } from "node:crypto";
import { makeCloze, type Cloze } from "./cloze";

export type BookCard = {
  id: string;
  term: string;
  sentence: string;
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
  cloze?: Cloze;
};

const optionsSchema = z.object({
  chapter: z.string().max(200).nullable(),
  priority: z.enum(["", "P1", "P2", "P3"]),
  limit: z.enum(["5", "10", "20"]).nullable(),
  mode: z.enum(["flashcard", "cloze"]),
});

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
  const chosen = new Map<
    string,
    {
      data: DraftInput;
      term: string;
      meaning: string;
      rank: number;
      cloze?: Cloze;
    }
  >();
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as DraftInput;
    chapters.add(data.chapter);
    if (
      !limit ||
      (chapter !== null && chapter !== data.chapter) ||
      (priority && priority !== row.priority)
    )
      continue;
    const status = data.importMetadata?.verificationStatus;
    const term = String(row.term);
    const cloze =
      mode === "cloze" && status !== "待补充"
        ? makeCloze(
            data.sentence,
            term,
            data.targetSurface,
            data.importMetadata?.highlightOccurrence,
          )
        : undefined;
    const sentenceRank = !data.sentence.trim()
      ? 0
      : status === "已核对完整句" || status === "已核对节选"
        ? 2
        : 1;
    const rank = sentenceRank + (cloze ? 3 : 0);
    const id = String(row.id);
    if ((chosen.get(id)?.rank ?? -1) < rank)
      chosen.set(id, {
        data,
        term,
        meaning: String(row.meaning),
        rank,
        cloze,
      });
  }
  const entries = [...chosen.entries()];
  const size = Number(limit);
  let selected = entries;
  if (mode === "cloze") {
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
    chapters: [...chapters].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    ),
    cards,
  };
}

export type BookFlashcards = ReturnType<typeof bookFlashcards>;
