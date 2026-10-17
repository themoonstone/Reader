import { DatabaseSync, backup } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  existsSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
const tables = [
  "sources",
  "expressions",
  "contexts",
  "drafts",
  "review_entries",
  "review_sessions",
  "review_cards",
  "review_records",
] as const;
function readonly(path: string) {
  if (!existsSync(path)) throw Error("数据库不存在");
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000;");
  return db;
}
function check(db: DatabaseSync) {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== 3)
    throw Error("仅支持 schema 3，请先使用兼容程序完成升级");
  for (const table of [...tables, "workspace_meta", "review_leases"])
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      throw Error("schema 3 缺少表");
  if (
    db.prepare("PRAGMA integrity_check").get()!.integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw Error("数据库完整性或引用校验失败");
}
export function manifest(path: string) {
  const db = readonly(path);
  try {
    db.exec("BEGIN");
    check(db);
    const rows = Object.fromEntries(
      tables.map((t) => {
        const rows = db.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
        return [
          t,
          {
            count: rows.length,
            digest: createHash("sha256")
              .update(JSON.stringify(rows))
              .digest("hex"),
          },
        ];
      }),
    );
    const generation = db
      .prepare("SELECT value FROM workspace_meta WHERE key='generation'")
      .get()?.value;
    if (!generation) throw Error("generation 丢失");
    db.exec("COMMIT");
    return {
      format: "readwords-manifest-v1",
      schema: 3,
      generation,
      tables: rows,
    };
  } finally {
    db.close();
  }
}
export function compareManifests(
  a: ReturnType<typeof manifest>,
  b: ReturnType<typeof manifest>,
) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function maintenance(path: string, enabled: boolean) {
  if (!existsSync(path)) throw Error("数据库不存在");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=10000;BEGIN IMMEDIATE;");
    check(db);
    db.prepare(
      "INSERT INTO workspace_meta(key,value) VALUES('maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(enabled ? "1" : "0");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}
function syncFile(path: string) {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function consistentBackup(source: string, directory: string) {
  if (resolve(source).startsWith(resolve(directory) + "/"))
    throw Error("备份目录不能包含源数据库");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = `readwords-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite`;
  const partial = join(directory, `.${name}.partial`),
    target = join(directory, name),
    db = readonly(source);
  try {
    check(db);
    await backup(db, partial);
    chmodSync(partial, 0o600);
    const copy = readonly(partial);
    try {
      check(copy);
    } finally {
      copy.close();
    }
    syncFile(partial);
    renameSync(partial, target);
    syncFile(directory);
    return target;
  } catch (error) {
    if (existsSync(partial)) unlinkSync(partial);
    throw error;
  } finally {
    db.close();
  }
}
