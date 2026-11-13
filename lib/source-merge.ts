import { z } from "zod";
import { AppError, type Store } from "./store";
import { type DraftInput, normalize, validateContext } from "./contracts";
import {
  materialState,
  sealChange,
  openChange,
  hashValue,
} from "./change-preview";
import { snapshotBeforeChange } from "./backup";
const selection = z.object({ fromId: z.uuid(), toId: z.uuid() });
function plan(store: Store, fromId: string, toId: string) {
  const from = store.getSource(fromId),
    to = store.getSource(toId);
  if (
    fromId === toId ||
    from.type !== to.type ||
    from.lifecycle !== "active" ||
    to.lifecycle !== "active"
  )
    throw new AppError("请选择两个不同的、同类型的有效来源");
  const moved = store.all(
    "SELECT * FROM contexts WHERE source_id=? ORDER BY created_at,id",
    fromId,
  );
  const kept = store.all(
    "SELECT * FROM contexts WHERE source_id=? ORDER BY created_at,id",
    toId,
  );
  for (const row of moved) {
    try {
      validateContext({ ...JSON.parse(String(row.data)), sourceId: toId }, to);
    } catch (error) {
      throw new AppError(
        `无法归入保留来源：${(error as Error).message}。请先核对来源资料。`,
      );
    }
  }
  const comparable = (row: (typeof moved)[number]) => {
    const d = JSON.parse(String(row.data)) as DraftInput;
    const metadata = d.importMetadata
      ? { ...d.importMetadata, fileName: "", sheet: "", row: 0, rowKey: "" }
      : undefined;
    return hashValue([
      row.expression_id,
      { ...d, sourceId: toId, importMetadata: metadata },
    ]);
  };
  const known = new Set(
    kept.filter((r) => r.lifecycle === "active").map(comparable),
  );
  const duplicates: string[] = [];
  for (const row of moved) {
    if (row.lifecycle !== "active") continue;
    const key = comparable(row);
    if (known.has(key)) duplicates.push(String(row.id));
    else known.add(key);
  }
  return {
    from,
    to,
    moved,
    duplicates,
    drafts: Number(
      store.one("SELECT count(*) AS n FROM drafts WHERE source_id=?", fromId)!
        .n,
    ),
    differentMetadata:
      normalize(from.author) !== normalize(to.author) ||
      from.date !== to.date ||
      from.duration !== to.duration,
  };
}
export function previewSourceMerge(store: Store, input: unknown) {
  const { fromId, toId } = selection.parse(input);
  return store.transaction(
    () => {
      const p = plan(store, fromId, toId);
      return {
        from: p.from,
        to: p.to,
        contexts: p.moved.length,
        duplicateContexts: p.duplicates.length,
        drafts: p.drafts,
        differentMetadata: p.differentMetadata,
        token: sealChange("source-merge", {
          fromId,
          toId,
          state: materialState(store),
        }),
      };
    },
    { readOnly: true },
  );
}
export function commitSourceMerge(store: Store, input: unknown) {
  const { token } = z
    .object({ token: z.string().max(8192), confirmed: z.literal(true) })
    .parse(input);
  return store.transaction(() => {
    const payload = openChange<{ fromId: string; toId: string; state: string }>(
      token,
      "source-merge",
    );
    if (payload.state !== materialState(store))
      throw new AppError(
        "来源或词条已变化，请重新预览合并",
        409,
        "PREVIEW_STALE",
      );
    const p = plan(store, payload.fromId, payload.toId);
    const snapshot = snapshotBeforeChange(store);
    const time = new Date().toISOString();
    const duplicateIds = new Set(p.duplicates);
    const affected = new Set<string>();
    for (const row of p.moved) {
      const d = {
        ...JSON.parse(String(row.data)),
        sourceId: p.to.id,
      } as DraftInput;
      const fingerprint = JSON.stringify([
        d.sourceId,
        d.sentence,
        d.correctedSentence,
        d.chapter,
        d.page,
        d.timestampSeconds,
        d.eventKind,
      ]);
      store.db
        .prepare(
          "UPDATE contexts SET source_id=?,data=?,fingerprint=?,lifecycle=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(
          p.to.id,
          JSON.stringify(d),
          fingerprint,
          duplicateIds.has(String(row.id)) ? "deleted" : row.lifecycle,
          time,
          row.id,
        );
      affected.add(String(row.expression_id));
    }
    for (const row of store.all(
      "SELECT id,data FROM drafts WHERE source_id=?",
      p.from.id,
    )) {
      const d = { ...JSON.parse(String(row.data)), sourceId: p.to.id };
      store.db
        .prepare(
          "UPDATE drafts SET source_id=?,data=?,version=version+1,updated_at=? WHERE id=?",
        )
        .run(p.to.id, JSON.stringify(d), time, row.id);
    }
    for (const id of affected)
      store.db
        .prepare(
          "UPDATE expressions SET version=version+1,updated_at=? WHERE id=?",
        )
        .run(time, id);
    store.db
      .prepare(
        "UPDATE sources SET lifecycle='archived',version=version+1,updated_at=? WHERE id=?",
      )
      .run(time, p.from.id);
    store.db
      .prepare("UPDATE sources SET version=version+1,updated_at=? WHERE id=?")
      .run(time, p.to.id);
    return {
      source: store.getSource(p.to.id),
      movedContexts: p.moved.length,
      duplicateContexts: p.duplicates.length,
      snapshot,
    };
  });
}
