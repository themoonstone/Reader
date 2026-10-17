"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { ErrorBox } from "./components";
type Counts = {
  sources: number;
  expressions: number;
  contexts: number;
  drafts: number;
  review_entries: number;
  review_sessions: number;
  review_cards: number;
  review_records: number;
};
type Preview = {
  token: string;
  warning: string;
  incoming: Counts;
  current: Counts;
  snapshot: string;
  expiresAt: string;
};
type Status = {
  snapshotDir: string;
  snapshots: { name: string }[];
  schemaVersion: number;
};
function download(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function BackupSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reload = () => api<Status>("backup/status").then(setStatus);
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, []);
  async function work(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-panel">
      <h2>备份与恢复</h2>
      <p>
        JSON 包含所有已保存表达、语境、来源、Inbox
        草稿、归档、回收站以及复习池、会话、卡片和反馈，可能含私人写作，请妥善保存。不包含运行租约或密钥。
      </p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void work(async () => {
            const data = await api("backup/export", "POST", {});
            download(
              data,
              `readwords-${new Date().toISOString().slice(0, 10)}.json`,
            );
            setNotice("已生成下载，请检查浏览器下载文件夹。");
          })
        }
      >
        下载全库 JSON 备份
      </button>
      <hr />
      <h3>从 JSON 替换本地学习库</h3>
      <p>
        不是合并。请先保存或复制所有窗口中未保存的输入。恢复会替换当前全库，其他旧窗口必须刷新后才能继续写入。
      </p>
      <label className="field">
        选择 ReadWords JSON 备份（上限 50 MB）
        <input
          aria-label="选择 JSON 备份"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(ev) => {
            const file = ev.target.files?.[0];
            ev.target.value = "";
            setPreview(null);
            setConfirmed(false);
            if (!file) return;
            void work(async () => {
              if (file.size > 50 * 1024 * 1024)
                throw new Error("备份文件不能超过 50 MB");
              let data;
              try {
                data = JSON.parse(await file.text());
              } catch {
                throw new Error("文件不是有效 JSON");
              }
              const result = await api<Preview>("backup/preview", "POST", data);
              setPreview(result);
              await reload();
            });
          }}
        />
      </label>
      {preview && (
        <div className="restore-preview">
          <h3>恢复预览</h3>
          {preview.warning && <p role="alert">{preview.warning}</p>}
          <table>
            <thead>
              <tr>
                <th>记录</th>
                <th>当前库</th>
                <th>将恢复</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["sources", "来源"],
                  ["expressions", "表达"],
                  ["contexts", "语境（含回收站）"],
                  ["drafts", "草稿（含已入库记录）"],
                  ["review_entries", "复习池（含暂停/移出）"],
                  ["review_sessions", "复习会话"],
                  ["review_cards", "复习卡片"],
                  ["review_records", "复习反馈"],
                ] as const
              ).map(([key, label]) => (
                <tr key={key}>
                  <td>{label}</td>
                  <td>{preview.current[key]}</td>
                  <td>{preview.incoming[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            已保存恢复前快照：<code>{preview.snapshot}</code>
          </p>
          <p>预览 10 分钟内有效；若期间数据变化需重新预览。</p>
          <label className="check">
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(ev) => setConfirmed(ev.target.checked)}
            />
            我确认用文件中的数据替换当前整个学习库
          </label>
          <button
            className="danger"
            disabled={busy || !confirmed}
            onClick={() =>
              void work(async () => {
                await api("backup/restore", "POST", {
                  token: preview.token,
                  confirmed: true,
                });
                window.location.hash = "settings";
                window.location.reload();
              })
            }
          >
            {busy ? "处理中…" : "确认替换整个学习库"}
          </button>
        </div>
      )}
      <hr />
      <h3>恢复前快照</h3>
      <p>
        预览时自动生成，不会自动清理。新预览会使超过数量上限的旧预览失效；重启服务后请重新预览。快照与数据库在同一台
        Mac，不能替代异地备份。
      </p>
      {status && (
        <>
          <p className="muted">
            schema {status.schemaVersion} · 快照目录：
            <code>{status.snapshotDir}</code>
          </p>
          {!status.snapshots.length && <p>尚无恢复前 JSON 快照。</p>}
          {status.snapshots.map((s) => (
            <div className="maintenance-row" key={s.name}>
              <code>{s.name}</code>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    download(
                      await api("backup/snapshot", "POST", { name: s.name }),
                      s.name,
                    );
                  })
                }
              >
                下载快照
              </button>
            </div>
          ))}
        </>
      )}
      <p className="muted">
        下载快照后，用上方“选择 JSON 备份”预览并恢复。升级 schema v1→v2、v2→v3
        前另有 SQLite 一致性快照供人工应急；定时自动备份尚未实现。
      </p>
    </section>
  );
}
