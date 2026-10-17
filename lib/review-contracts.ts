import { z } from "zod";
export const REVIEW_POLICY = {
  version: "low-pressure-v1",
  poolLimit: 20,
  dailyNewLimit: 5,
  heartbeatMs: 5000,
  leaseMs: 15000,
  intervals: [3, 7, 14, 30, 60, 90],
} as const;
const id = z.uuid(),
  time = z.iso.datetime(),
  nullableTime = time.nullable(),
  v = z.number().int().positive();
export const reviewEntrySchema = z
  .object({
    id,
    expression_id: id,
    state: z.enum(["not_joined", "active", "paused"]),
    pause_reason: z.string().max(100),
    stage: z.number().int().min(0).max(5),
    eligible_after: nullableTime,
    first_presented_at: nullableTime,
    first_presented_local_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    first_presented_timezone: z.string().max(100).nullable(),
    last_presented_at: nullableTime,
    last_reviewed_at: nullableTime,
    version: v,
    last_pool_operation_id: id,
    created_at: time,
    updated_at: time,
  })
  .strict();
export const reviewSettingsSchema = z.object({
  budget_seconds: z.union([z.literal(600), z.literal(1200), z.literal(1800)]),
  card_limit: z.union([z.literal(5), z.literal(10), z.literal(20)]),
  new_limit: z.number().int().min(0).max(5),
});
export const reviewSessionSchema = reviewSettingsSchema
  .extend({
    id,
    start_request_id: id,
    state: z.enum(["running", "paused", "ended"]),
    active_elapsed_ms: z.number().int().nonnegative(),
    issued_count: z.number().int().min(0).max(20),
    introduced_count: z.number().int().min(0).max(5),
    current_card_id: id.nullable(),
    policy_version: z.literal("low-pressure-v1"),
    policy: z
      .object({
        version: z.literal("low-pressure-v1"),
        poolLimit: z.literal(20),
        dailyNewLimit: z.literal(5),
        heartbeatMs: z.literal(5000),
        leaseMs: z.literal(15000),
        intervals: z.tuple([
          z.literal(3),
          z.literal(7),
          z.literal(14),
          z.literal(30),
          z.literal(60),
          z.literal(90),
        ]),
      })
      .strict(),
    version: v,
    started_at: time,
    ended_at: nullableTime,
    end_reason: z.enum([
      "",
      "time_limit",
      "card_limit",
      "no_candidates",
      "user",
    ]),
    last_checkpoint_at: time,
  })
  .strict();
export const reviewSnapshotSchema = z
  .object({
    front: z
      .object({
        term: z.string().min(1).max(200),
        sentence: z.string().min(1).max(10000),
      })
      .strict(),
    answer: z
      .object({
        meaning: z.string().min(1).max(1000),
        contextMeaning: z.string().min(1).max(1000),
        simpleParaphrase: z.string().max(3000),
        contextLanguage: z.enum(["en", "user"]),
        sourceTitle: z.string().max(200),
        sourceType: z.string().max(20),
        chapter: z.string().max(200),
        page: z.string().max(100),
        timestamp: z.string().max(20),
      })
      .strict(),
  })
  .strict();
export const reviewCardSchema = z
  .object({
    id,
    session_id: id,
    entry_id: id,
    expression_id: id,
    context_id: id,
    issue_request_id: id,
    review_type: z.literal("recognition"),
    state: z.enum(["shown", "revealed", "answered", "skipped", "invalidated"]),
    snapshot: reviewSnapshotSchema,
    expression_version: v,
    context_version: v,
    source_version: v,
    entry_version: v,
    is_first_presentation: z.union([z.literal(0), z.literal(1)]),
    presented_local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    presented_timezone: z.string().max(100),
    version: v,
    created_at: time,
    revealed_at: nullableTime,
  })
  .strict();
export const reviewResultSchema = z.enum(["forgot", "hard", "remember"]);
export const reviewRecordSchema = z
  .object({
    id,
    card_id: id,
    session_id: id,
    entry_id: id,
    original_expression_id: id,
    context_id: id,
    review_type: z.literal("recognition"),
    result: reviewResultSchema,
    reviewed_at: time,
    old_stage: z.number().int().min(0).max(5),
    new_stage: z.number().int().min(0).max(5),
    old_eligible_after: nullableTime,
    new_eligible_after: time,
    policy_version: z.literal("low-pressure-v1"),
    snapshot: reviewSnapshotSchema,
  })
  .strict();
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;
export type ReviewSession = z.infer<typeof reviewSessionSchema>;
export type ReviewCard = z.infer<typeof reviewCardSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
export type ReviewView = {
  lease?: { ownerTab: string; expiresAt: string; version: number };
  leaseToken?: string;
  issuedCardId?: string;
  session: ReviewSession | null;
  card:
    | (Omit<ReviewCard, "snapshot"> & {
        front: ReviewCard["snapshot"]["front"];
        answer?: ReviewCard["snapshot"]["answer"];
      })
    | null;
  feedbackCount: number;
  results: Record<ReviewResult, number>;
  notice?: string;
};
export type ReviewPool = {
  entries: (ReviewEntry & {
    term: string;
    meaning: string;
    priority: string;
    eligible: boolean;
  })[];
  activeCount: number;
  limit: number;
};
export type ReviewCandidates = {
  items: {
    id: string;
    term: string;
    meaning: string;
    priority: string;
    eligible: boolean;
    reason: string;
    entry: ReviewEntry | null;
  }[];
  total: number;
  page: number;
};
export function reviewInterval(
  stage: number,
  result: ReviewResult,
  at: number,
) {
  let newStage = stage,
    days: number;
  if (result === "remember") {
    days = REVIEW_POLICY.intervals[stage];
    newStage = Math.min(stage + 1, 5);
  } else if (result === "hard") {
    newStage = Math.max(stage - 1, 0);
    days = Math.max(1, Math.floor(REVIEW_POLICY.intervals[newStage] / 2));
  } else {
    newStage = 0;
    days = 1;
  }
  return {
    stage: newStage,
    eligibleAfter: new Date(at + days * 86400000).toISOString(),
  };
}
