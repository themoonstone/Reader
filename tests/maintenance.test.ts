import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store, AppError } from "../lib/store";
import { emptyDraft } from "../lib/contracts";
import {
  exportBackup,
  validateBackup,
  previewRestore,
  commitRestore,
  readSnapshot,
  snapshots,
} from "../lib/backup";
import { handle } from "../lib/http";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rw-maintenance-"));
  const store = new Store(join(dir, "db.sqlite"));
  const source = store.createSource({
    id: randomUUID(),
    type: "Manual",
    title: "维护测试",
  });
  const d = store.createDraft(randomUUID(), {
    ...emptyDraft("Manual", source.id),
    term: "keep going",
    meaning: "继续",
    sentence: "Keep going.",
  });
  const eid = store.saveDraft(d.id, { version: 1 }).expressionId!;
  return {
    dir,
    store,
    source,
    eid,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const stable = (b: ReturnType<typeof exportBackup>) => ({
  ...b,
  exported_at: "",
});
test("expression edits preserve contexts, archive/search works and stale versions reject", () => {
  const f = fixture(),
    { store, eid } = f;
  try {
    const before = store.expression(eid);
    const updated = store.updateExpression(
      eid,
      {
        ...before,
        term: "Keep Going",
        meaning: "坚持下去",
        priority: "P3",
        type: "phrase",
        alternative: "continue",
      },
      before.version,
      "archived",
    );
    assert.equal(updated.priority, "P3");
    assert.deepEqual(updated.contexts, before.contexts);
    assert.equal(store.search("Keep Going").length, 0);
    assert.equal(store.search("Keep Going", "", "", true).length, 1);
    assert.throws(
      () => store.updateExpression(eid, before, before.version),
      (e) => e instanceof AppError && e.code === "VERSION_CONFLICT",
    );
    assert.throws(() =>
      store.updateExpression(eid, { ...updated, term: "" }, updated.version),
    );
  } finally {
    f.cleanup();
  }
});
test("context editing and reparenting recompute counts and preserve provenance and saved-result links", () => {
  const f = fixture(),
    { store, eid, source } = f;
  try {
    const targetDraft = store.createDraft(randomUUID(), {
      ...emptyDraft("Manual", source.id),
      term: "continue",
      meaning: "继续进行",
    });
    const target = store.saveDraft(targetDraft.id, {
      version: 1,
    }).expressionId!;
    const c = store.expression(eid).contexts[0];
    const result = store.updateContext(
      c.id,
      {
        ...c.data,
        eventKind: "output_used",
        sentence: "I keep going every day.",
      },
      c.version,
      target,
    );
    assert.equal(result.expressionId, target);
    assert.equal(store.expression(eid).contextCount, 0);
    assert.equal(store.expression(target).used, 1);
    assert.equal(store.expression(target).seen, 1);
    assert.equal(store.getSource(source.id).expressionCount, 1);
    assert.throws(
      () => store.updateContext(c.id, c.data, c.version, eid),
      (e) => e instanceof AppError && e.code === "VERSION_CONFLICT",
    );
    assert.doesNotThrow(() => validateBackup(exportBackup(store)));
    assert.equal(store.saveDraft(targetDraft.id, { version: 1 }).replay, true);
  } finally {
    f.cleanup();
  }
});
test("context validation rejects invalid writing/listening/source/date and duplicate moves atomically", () => {
  const f = fixture(),
    { store, eid } = f;
  try {
    const c = store.expression(eid).contexts[0],
      before = stable(exportBackup(store));
    for (const data of [
      { ...c.data, eventKind: "output_corrected" },
      { ...c.data, occurredOn: "2026-02-30" },
      { ...c.data, sourceId: randomUUID() },
      { ...c.data, timestamp: "03:00" },
      { ...c.data, whySaved: "other", note: "" },
    ])
      assert.throws(() => store.updateContext(c.id, data, c.version, eid));
    assert.deepEqual(stable(exportBackup(store)), before);
    const second = store.createDraft(randomUUID(), {
      ...c.data,
      sentence: "Another day.",
    });
    store.saveDraft(second.id, { version: 1, expressionId: eid });
    const other = store.expression(eid).contexts.find((x) => x.id !== c.id)!;
    assert.throws(
      () => store.updateContext(other.id, c.data, other.version, eid),
      (e) => e instanceof AppError && e.code === "DUPLICATE_CONTEXT",
    );
    assert.doesNotThrow(() =>
      store.updateContext(other.id, c.data, other.version, eid, true),
    );
  } finally {
    f.cleanup();
  }
});
test("individual delete survives expression cascade delete/restore, archived lifecycle is restored", () => {
  const f = fixture(),
    { store, eid } = f;
  try {
    const first = store.expression(eid).contexts[0];
    store.setContextDeleted(first.id, first.version, true);
    let exp = store.expression(eid);
    assert.equal(exp.seen, 0);
    assert.equal(exp.contextCount, 0);
    assert.equal(exp.deletedContexts.length, 1);
    const d = store.createDraft(randomUUID(), {
      ...first.data,
      sentence: "Second context.",
    });
    store.saveDraft(d.id, { version: 1, expressionId: eid });
    exp = store.expression(eid);
    exp = store.updateExpression(eid, exp, exp.version, "archived");
    store.deleteExpression(eid, exp.version);
    exp = store.expression(eid);
    assert.equal(exp.contextCount, 0);
    assert.equal(store.trash().length, 1);
    assert.throws(() =>
      store.setContextDeleted(first.id, store.context(first.id).version, false),
    );
    exp = store.restoreExpression(eid, exp.version);
    assert.equal(exp.lifecycle, "archived");
    assert.equal(exp.contextCount, 1);
    assert.equal(exp.deletedContexts.length, 1);
    store.setContextDeleted(first.id, store.context(first.id).version, false);
    assert.equal(store.expression(eid).seen, 2);
    assert.doesNotThrow(() => validateBackup(exportBackup(store)));
  } finally {
    f.cleanup();
  }
});
test("backup roundtrip keeps stable IDs, edited/deleted/archive/ignored drafts and generation changes", () => {
  const f = fixture(),
    { store, eid, source } = f;
  try {
    const ignored = store.createDraft(randomUUID(), {
      ...emptyDraft("Manual"),
      term: "pending",
    });
    store.updateDraft(ignored.id, ignored.data, ignored.version, "ignored");
    store.updateSource(source.id, source, source.version, "archived");
    const e = store.expression(eid);
    store.deleteExpression(eid, e.version);
    const b = exportBackup(store),
      generation = store.generation;
    store.createSource({
      id: randomUUID(),
      type: "Reading",
      title: "Replace me",
    });
    const before = exportBackup(store),
      preview = previewRestore(store, b);
    assert.deepEqual(
      stable(readSnapshot(store, preview.snapshot)),
      stable(before),
    );
    assert.equal(
      statSync(join(store.snapshotDir, preview.snapshot)).mode & 0o777,
      0o600,
    );
    assert.throws(() => commitRestore(store, preview.token, false));
    commitRestore(store, preview.token, true);
    assert.notEqual(store.generation, generation);
    assert.deepEqual(stable(exportBackup(store)), stable(b));
    assert.throws(() => commitRestore(store, preview.token, true));
    const recovered = previewRestore(
      store,
      readSnapshot(store, preview.snapshot),
    );
    commitRestore(store, recovered.token, true);
    assert.deepEqual(stable(exportBackup(store)), stable(before));
  } finally {
    f.cleanup();
  }
});
test("invalid backup variants are rejected before snapshots or database writes", () => {
  const f = fixture(),
    { store } = f;
  try {
    const b = exportBackup(store),
      before = stable(b);
    const variants: unknown[] = [
      { ...b, schema_version: 99 },
      { ...b, sources: [...b.sources, b.sources[0]] },
      { ...b, contexts: [{ ...b.contexts[0], source_id: randomUUID() }] },
      { ...b, contexts: [{ ...b.contexts[0], fingerprint: "bad" }] },
      { ...b, drafts: [{ ...b.drafts[0], context_id: randomUUID() }] },
      { ...b, expressions: [{ ...b.expressions[0], created_at: "yesterday" }] },
      {
        ...b,
        expressions: [{ ...b.expressions[0], normalized_term: "wrong" }],
      },
      {
        ...b,
        contexts: [
          {
            ...b.contexts[0],
            lifecycle: "active",
            deleted_by: b.expressions[0].id,
          },
        ],
      },
    ];
    for (const v of variants) assert.throws(() => previewRestore(store, v));
    assert.deepEqual(stable(exportBackup(store)), before);
    assert.equal(snapshots(store).length, 0);
    assert.throws(() => readSnapshot(store, "../../secrets"));
  } finally {
    f.cleanup();
  }
});
test("changed current library and stale/expired/foreign preview refuse replacement", () => {
  const f = fixture(),
    g = fixture();
  try {
    const b = exportBackup(f.store),
      p = previewRestore(f.store, b);
    assert.throws(() => commitRestore(g.store, p.token, true));
    f.store.createSource({
      id: randomUUID(),
      type: "Reading",
      title: "New work",
    });
    const before = stable(exportBackup(f.store));
    assert.throws(() => commitRestore(f.store, p.token, true), /已有变化/);
    assert.deepEqual(stable(exportBackup(f.store)), before);
    const savedNow = Date.now;
    const q = previewRestore(f.store, b);
    try {
      Date.now = () => savedNow() + 11 * 60 * 1000;
      assert.throws(() => commitRestore(f.store, q.token, true), /失效/);
    } finally {
      Date.now = savedNow;
    }
  } finally {
    f.cleanup();
    g.cleanup();
  }
});
test("mid-restore failure rolls back data and generation while pre-restore snapshot remains usable", () => {
  const f = fixture(),
    { store } = f;
  try {
    const incoming = exportBackup(store);
    incoming.sources[0].title = "Incoming";
    incoming.sources[0].data.title = "Incoming";
    const p = previewRestore(store, incoming),
      before = stable(exportBackup(store)),
      generation = store.generation;
    store.db.exec(
      "CREATE TEMP TRIGGER fail_restore BEFORE INSERT ON contexts BEGIN SELECT RAISE(ABORT,'injected'); END;",
    );
    assert.throws(() => commitRestore(store, p.token, true));
    assert.deepEqual(stable(exportBackup(store)), before);
    assert.equal(store.generation, generation);
    assert.deepEqual(stable(readSnapshot(store, p.snapshot)), before);
    store.db.exec("DROP TRIGGER fail_restore");
    commitRestore(store, p.token, true);
    assert.equal(store.sources()[0].title, "Incoming");
  } finally {
    f.cleanup();
  }
});
test("snapshot disk failure prevents preview and leaves original database unchanged", () => {
  const f = fixture(),
    { store } = f;
  try {
    mkdirSync(dirname(store.snapshotDir), { recursive: true });
    writeFileSync(store.snapshotDir, "blocking file");
    const b = exportBackup(store);
    assert.throws(() => previewRestore(store, b));
    assert.deepEqual(stable(exportBackup(store)), stable(b));
  } finally {
    f.cleanup();
  }
});
test("real v1 file migrates with a readable pre-upgrade SQLite snapshot and stable records", () => {
  const f = fixture(),
    { dir, eid } = f;
  let upgraded: Store | undefined;
  try {
    const b = exportBackup(f.store);
    f.store.close();
    // Reconstruct the exact v1 columns from the previous documented schema.
    const file = join(dir, "v1.sqlite"),
      db = new DatabaseSync(file);
    db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY,type TEXT NOT NULL,title TEXT NOT NULL,data TEXT NOT NULL,lifecycle TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE expressions(id TEXT PRIMARY KEY,term TEXT NOT NULL,normalized_term TEXT NOT NULL,meaning TEXT NOT NULL,type TEXT NOT NULL,priority TEXT NOT NULL,alternative TEXT NOT NULL,lifecycle TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE contexts(id TEXT PRIMARY KEY,expression_id TEXT NOT NULL REFERENCES expressions(id),source_id TEXT NOT NULL REFERENCES sources(id),event_kind TEXT NOT NULL,data TEXT NOT NULL,fingerprint TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE drafts(id TEXT PRIMARY KEY,source_id TEXT REFERENCES sources(id),data TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,expression_id TEXT REFERENCES expressions(id),context_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); PRAGMA user_version=1;`);
    for (const table of [
      "sources",
      "expressions",
      "contexts",
      "drafts",
    ] as const)
      for (const record of b[table]) {
        const row: Record<string, unknown> = { ...record };
        if (table === "expressions") delete row.restore_lifecycle;
        if (table === "contexts") {
          delete row.lifecycle;
          delete row.version;
          delete row.updated_at;
          delete row.deleted_by;
        }
        if (row.data) row.data = JSON.stringify(row.data);
        const keys = Object.keys(row);
        db.prepare(
          `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
        ).run(...keys.map((k) => row[k] as string | number | null));
      }
    db.close();
    upgraded = new Store(file);
    assert.equal(upgraded.expression(eid).seen, 1);
    assert.doesNotThrow(() => validateBackup(exportBackup(upgraded!)));
    const name = readdirSync(upgraded.snapshotDir).find((n) =>
      n.startsWith("before-schema-v2"),
    )!;
    const snap = new DatabaseSync(join(upgraded.snapshotDir, name), {
      readOnly: true,
    });
    try {
      assert.equal(snap.prepare("PRAGMA user_version").get()!.user_version, 1);
      assert.equal(
        snap.prepare("SELECT count(*) AS n FROM contexts").get()!.n,
        1,
      );
    } finally {
      snap.close();
    }
  } finally {
    upgraded?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP restore and maintenance enforce Origin, generation, explicit confirmation, limits and route contracts", async () => {
  const f = fixture(),
    { store, eid } = f;
  try {
    const req = async (
      path: string,
      body: unknown,
      generation: string | null = store.generation,
      origin = "http://127.0.0.1:3000",
      method = "POST",
    ) =>
      handle(
        new Request(`http://127.0.0.1:3000/api/${path}`, {
          method,
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            ...(generation ? { "X-ReadWords-Generation": generation } : {}),
          },
          body: JSON.stringify(body),
        }),
        path.split("/"),
        store,
      );
    const before = stable(exportBackup(store));
    assert.equal((await req("backup/export", {}, null)).status, 409);
    assert.equal(
      (await req("backup/export", {}, store.generation, "https://evil.test"))
        .status,
      403,
    );
    assert.equal(
      (
        await req(
          `expressions/${eid}`,
          { data: store.expression(eid), version: 1 },
          store.generation,
          "http://127.0.0.1:3000",
          "PATCH",
        )
      ).status,
      200,
    );
    const exported = await (await req("backup/export", {})).json();
    const p = await (await req("backup/preview", exported)).json();
    assert.equal(
      (await req("backup/restore", { token: p.token, confirmed: false }))
        .status,
      400,
    );
    const generation = store.generation;
    assert.equal(
      (await req("backup/restore", { token: p.token, confirmed: true })).status,
      200,
    );
    assert.equal(
      (
        await req(
          "sources",
          { id: randomUUID(), title: "stale", type: "Manual" },
          generation,
        )
      ).status,
      409,
    );
    assert.equal(
      (await req("backup/preview", { ...exported, schema_version: 9 })).status,
      400,
    );
    assert.equal(
      (await req("backup/preview", { padding: "x".repeat(50 * 1024 * 1024) }))
        .status,
      413,
    );
    assert.equal(store.sources().length, before.sources.length);
  } finally {
    f.cleanup();
  }
});

test("missing or corrupt recovery snapshot prevents confirmation without modifying the library", () => {
  const f = fixture();
  try {
    const b = exportBackup(f.store),
      before = stable(b);
    const p = previewRestore(f.store, b);
    unlinkSync(join(f.store.snapshotDir, p.snapshot));
    assert.throws(() => commitRestore(f.store, p.token, true));
    const q = previewRestore(f.store, b);
    writeFileSync(join(f.store.snapshotDir, q.snapshot), "{}");
    assert.throws(() => commitRestore(f.store, q.token, true));
    assert.deepEqual(stable(exportBackup(f.store)), before);
  } finally {
    f.cleanup();
  }
});
test("databases in one directory keep separate snapshot lists", () => {
  const f = fixture(),
    other = new Store(join(f.dir, "other.sqlite"));
  try {
    previewRestore(f.store, exportBackup(f.store));
    previewRestore(other, exportBackup(other));
    assert.notEqual(f.store.snapshotDir, other.snapshotDir);
    assert.equal(snapshots(f.store).length, 1);
    assert.equal(snapshots(other).length, 1);
  } finally {
    other.close();
    f.cleanup();
  }
});
