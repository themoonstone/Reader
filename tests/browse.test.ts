import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  browseIds,
  browseNeighbor,
  readBrowse,
  listParams,
  type BrowseContext,
} from "../lib/browse";
import { Store } from "../lib/store";
import { handle } from "../lib/http";
import { emptyDraft } from "../lib/contracts";

const ids = Array.from({ length: 4 }, () => randomUUID());
const context: BrowseContext = {
  version: 1,
  origin: `source/${randomUUID()}`,
  query: "a & 中文",
  type: "Reading",
  priority: "P1",
  archived: true,
  ids,
  anchor: ids[1],
  scrollY: 1223,
};
test("history context validates origin, filters, unique IDs and anchor; malformed history fails closed", () => {
  assert.deepEqual(readBrowse(context), context);
  for (const value of [
    null,
    {},
    { ...context, version: 2 },
    { ...context, origin: "https://example.com" },
    { ...context, type: "bad" },
    { ...context, ids: [ids[0], ids[0]] },
    { ...context, anchor: randomUUID() },
    { ...context, scrollY: -1 },
  ])
    assert.equal(readBrowse(value), null);
  const params = new URLSearchParams(
    listParams(
      context.origin,
      context.query,
      context.type,
      context.priority,
      context.archived,
    ),
  );
  assert.equal(params.get("sourceId"), context.origin.slice(7));
  assert.equal(params.get("q"), context.query);
  assert.equal(params.get("archived"), "1");
  assert.equal(
    new URLSearchParams(listParams("search", "", "", "", false)).get(
      "sourceId",
    ),
    "",
  );
});
test("navigation freezes entry order, ignores new results and skips missing items without wrapping", () => {
  const live = [ids[3], ids[1], randomUUID()];
  assert.deepEqual(browseIds(context, live), [ids[1], ids[3]]);
  assert.equal(browseNeighbor(context, live, ids[1], 1), ids[3]);
  assert.equal(browseNeighbor(context, live, ids[1], -1), undefined);
  assert.equal(browseNeighbor(context, live, ids[3], 1), undefined);
  assert.equal(browseNeighbor(context, live, ids[2], -1), ids[1]);
  assert.equal(browseNeighbor(context, [], ids[1], 1), undefined);
  assert.equal(browseNeighbor(context, live, randomUUID(), 1), undefined);
});
test("IDs-only API uses the exact search scope/order and leaves expression and generation unchanged", async () => {
  const db = new Store(":memory:");
  try {
    const source = db.createSource({
      id: randomUUID(),
      type: "Reading",
      title: "Browse test",
    });
    for (const [term, priority] of [
      ["nav one", "P1"],
      ["nav two", "P2"],
      ["outside", "P1"],
    ]) {
      const draft = db.createDraft(randomUUID(), {
        ...emptyDraft("Reading", source.id),
        term,
        meaning: "测试",
        priority: priority as "P1" | "P2",
      });
      db.saveDraft(draft.id, { version: draft.version });
    }
    const before = db.search();
    const generation = db.generation;
    const params = listParams(
      `source/${source.id}`,
      "nav",
      "Reading",
      "P1",
      false,
    );
    const full = await handle(
      new Request(`http://localhost:3000/api/expressions?${params}`),
      ["expressions"],
      db,
    );
    const minimal = await handle(
      new Request(`http://localhost:3000/api/expressions?${params}&idsOnly=1`),
      ["expressions"],
      db,
    );
    assert.equal(full.status, 200);
    assert.equal(minimal.status, 200);
    const entries = await full.json();
    assert.equal(entries.length, 1);
    assert.deepEqual(
      await minimal.json(),
      entries.map((item: { id: string }) => item.id),
    );
    assert.deepEqual(db.search(), before);
    assert.equal(db.generation, generation);
  } finally {
    db.close();
  }
});
