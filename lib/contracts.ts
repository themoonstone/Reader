import { z } from "zod";

export const sourceTypes = [
  "Reading",
  "Listening",
  "Writing",
  "Manual",
] as const;
export const events = [
  "exposure",
  "output_failed",
  "output_corrected",
  "output_used",
] as const;
export const reasons = [
  "did_not_understand",
  "misheard",
  "useful",
  "could_not_produce",
  "writing_correction",
  "want_to_use",
  "other",
] as const;
export const reasonLabels: Record<string, string> = {
  did_not_understand: "没有理解",
  misheard: "听错了",
  useful: "好用的表达",
  could_not_produce: "想表达但不会",
  writing_correction: "写作中被纠正",
  want_to_use: "希望主动使用",
  other: "其他",
};
export const eventLabels: Record<string, string> = {
  exposure: "遇见",
  output_failed: "表达失败",
  output_corrected: "获得纠正",
  output_used: "已自主使用",
};
const text = (max = 1000) => z.string().trim().max(max);
export const sourceSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(sourceTypes),
    title: text(200).min(1, "请填写来源标题"),
    author: text(200).default(""),
    url: text(2000).default(""),
    date: text(10).default(""),
    readingStatus: z
      .enum(["want_to_read", "reading", "finished", "paused"])
      .default("reading"),
    currentChapter: text(200).default(""),
    format: text(100).default(""),
    duration: z
      .union([z.literal(""), z.number().int().nonnegative()])
      .default(""),
  })
  .superRefine((s, ctx) => {
    if (s.url) {
      try {
        if (!["http:", "https:"].includes(new URL(s.url).protocol))
          throw Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "链接需以 http:// 或 https:// 开头",
        });
      }
    }
    if (s.date && !validDate(s.date))
      ctx.addIssue({ code: "custom", path: ["date"], message: "日期无效" });
  });
export const draftSchema = z.object({
  term: text(200).min(1, "请填写目标表达"),
  sourceType: z.enum(sourceTypes),
  sourceId: z.union([z.uuid(), z.literal("")]).default(""),
  sentence: text(10000).default(""),
  meaning: text().default(""),
  expressionType: z
    .enum(["word", "phrase", "collocation", "chunk", "sentence_pattern"])
    .default("chunk"),
  priority: z.enum(["P1", "P2", "P3"]).default("P2"),
  eventKind: z.enum(events).default("exposure"),
  whySaved: z.enum(reasons).default("useful"),
  chapter: text(200).default(""),
  page: text(100).default(""),
  timestamp: text(20).default(""),
  timestampSeconds: z.number().int().nonnegative().nullable().default(null),
  occurredOn: text(10).default(""),
  note: text(3000).default(""),
  misheard: text().default(""),
  originalExpression: text(200).default(""),
  correctedExpression: text(200).default(""),
  correctedSentence: text(10000).default(""),
  intendedMeaning: text().default(""),
  alternative: text().default(""),
  targetSurface: text(200).default(""),
  importMetadata: z
    .object({
      profile: z.literal("bebe-strict-v1"),
      rowKey: z.string().length(64),
      fileName: text(250),
      sheet: text(200),
      row: z.number().int().positive(),
      contextMeaningEnglish: text(3000),
      dictionaryEnglish: text(3000),
      dictionaryChinese: text(1000),
      ipa: text(500),
      partOfSpeech: text(200),
      rationale: text(3000),
      learningTarget: text(1000),
      originalPriority: text(200),
      normalizedItem: text(200),
      bookCount: text(100),
      priorityConflict: z.boolean(),
      excerpt: z.boolean(),
    })
    .optional(),
});
export type DraftInput = z.infer<typeof draftSchema>;
export type SourceInput = z.infer<typeof sourceSchema>;
export type Source = SourceInput & {
  lifecycle: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  expressionCount: number;
};
export type Draft = {
  id: string;
  version: number;
  state: "pending" | "ignored" | "saved";
  data: DraftInput;
  createdAt: string;
  updatedAt: string;
  expressionId: string | null;
};
export type Context = {
  id: string;
  sourceId: string;
  sourceTitle: string;
  sourceType: string;
  data: DraftInput;
  createdAt: string;
};
export type Expression = {
  id: string;
  term: string;
  meaning: string;
  type: string;
  priority: string;
  lifecycle: string;
  alternative: string;
  createdAt: string;
  updatedAt: string;
  seen: number;
  used: number;
  contextCount: number;
  sourceCount: number;
  contexts: Context[];
  matches?: string[];
};
export function normalize(s: string) {
  return s
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}
export function validDate(s: string) {
  const d = new Date(`${s}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === s
  );
}
export function parseTimestamp(s: string): number | null {
  if (!s) return null;
  if (!/^(\d+:)?\d{1,3}:[0-5]\d$/.test(s))
    throw new Error("时间位置需为 mm:ss 或 hh:mm:ss");
  const parts = s.split(":").map(Number);
  if (parts.length === 3 && parts[1] > 59)
    throw new Error("分钟需在 00–59 之间");
  const value = parts.reduce((a, b) => a * 60 + b, 0);
  if (!Number.isSafeInteger(value)) throw new Error("时间位置过大");
  return value;
}
export function emptyDraft(
  type: DraftInput["sourceType"] = "Reading",
  sourceId = "",
): DraftInput {
  return {
    ...draftSchema.parse({
      term: "placeholder",
      sourceType: type,
      sourceId,
      eventKind: type === "Writing" ? "output_failed" : "exposure",
    }),
    term: "",
  };
}
