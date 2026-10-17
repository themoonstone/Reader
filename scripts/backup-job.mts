import { consistentBackup } from "../lib/operations.ts";
import { spawnSync } from "node:child_process";
import {
  readdirSync,
  statSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const directory = process.env.READWORDS_BACKUP_DIR || "/app/backups";
let lock: number | undefined;
function restic(args: string[]) {
  const result = spawnSync("restic", args, {
    stdio: "ignore",
    timeout: 30 * 60 * 1000,
    env: process.env,
  });
  if (result.status !== 0 || result.error) throw Error("异地加密备份失败");
}
try {
  if (
    !process.env.READWORDS_DB_PATH ||
    !process.env.RESTIC_REPOSITORY ||
    !process.env.RESTIC_PASSWORD_FILE
  )
    throw Error("备份配置不完整");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  lock = openSync(join(directory, ".backup.lock"), "wx", 0o600);
  writeFileSync(lock, String(process.pid));
  const file = await consistentBackup(process.env.READWORDS_DB_PATH, directory);
  // Constant root and tag prevent per-filename snapshot groups from defeating retention.
  restic([
    "backup",
    "--tag",
    "readwords",
    "--host",
    "readwords",
    directory,
    "--exclude",
    join(directory, ".backup.lock"),
    "--exclude",
    "*.partial",
  ]);
  restic([
    "forget",
    "--tag",
    "readwords",
    "--group-by",
    "host,tags",
    "--keep-daily",
    "7",
    "--keep-weekly",
    "4",
    "--prune",
  ]);
  restic(["check"]);
  const files = readdirSync(directory)
    .filter((n) => /^readwords-[\w-]+\.sqlite$/.test(n))
    .map((name) => ({ name, at: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  // Local fallback retains daily and weekly representatives too; remote success is required before pruning.
  const days = new Set<string>(),
    weeks = new Set<string>(),
    keep = new Set<string>();
  for (const f of files) {
    const d = new Date(f.at),
      day = d.toISOString().slice(0, 10),
      week = String(Math.floor((f.at - 3 * 86400000) / (7 * 86400000)));
    if (!days.has(day) && days.size < 7) {
      days.add(day);
      keep.add(f.name);
    }
    if (!weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      keep.add(f.name);
    }
  }
  for (const f of files)
    if (!keep.has(f.name)) unlinkSync(join(directory, f.name));
  writeFileSync(join(directory, ".last-success"), new Date().toISOString(), {
    mode: 0o600,
  });
  console.log(`READWORDS_BACKUP_OK ${file.split("/").pop()}`);
} catch {
  console.error(
    "READWORDS_BACKUP_FAILED: 请检查配置、锁、磁盘、远端仓库及凭据；未将本次作业标为成功。",
  );
  process.exitCode = 1;
} finally {
  if (lock !== undefined) {
    closeSync(lock);
    unlinkSync(join(directory, ".backup.lock"));
  }
}
