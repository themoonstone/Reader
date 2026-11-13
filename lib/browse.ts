import { z } from "zod";

const id = z.uuid();
const schema = z.object({
  version: z.literal(1),
  origin: z.union([
    z.literal("search"),
    z.string().regex(/^source\/[0-9a-f-]{36}$/i),
  ]),
  query: z.string(),
  type: z.enum(["", "Reading", "Listening", "Writing", "Manual"]),
  priority: z.enum(["", "P1", "P2", "P3"]),
  archived: z.boolean(),
  ids: z.array(id),
  anchor: id,
  scrollY: z.number().finite().nonnegative(),
});
export type BrowseContext = z.infer<typeof schema>;

export function readBrowse(value: unknown): BrowseContext | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const context = parsed.data;
  if (
    new Set(context.ids).size !== context.ids.length ||
    !context.ids.includes(context.anchor)
  )
    return null;
  return context;
}

export function listParams(
  view: string,
  query: string,
  type: string,
  priority: string,
  archived: boolean,
) {
  return new URLSearchParams({
    q: query,
    type,
    priority,
    archived: archived ? "1" : "0",
    sourceId: view.startsWith("source/") ? view.slice(7) : "",
  }).toString();
}

// Keep the entry order; live membership only removes unavailable/out-of-scope items.
export function browseIds(context: BrowseContext, liveIds: string[]) {
  const live = new Set(liveIds);
  return context.ids.filter((value) => live.has(value));
}

export function browseNeighbor(
  context: BrowseContext,
  liveIds: string[],
  current: string,
  direction: -1 | 1,
) {
  const index = context.ids.indexOf(current);
  if (index < 0) return undefined;
  const live = new Set(liveIds);
  for (
    let i = index + direction;
    i >= 0 && i < context.ids.length;
    i += direction
  ) {
    if (live.has(context.ids[i])) return context.ids[i];
  }
}
