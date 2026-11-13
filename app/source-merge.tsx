"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { normalize, type Source } from "@/lib/contracts";
import { ErrorBox, Field, Modal } from "./components";
type Preview = {
  token: string;
  from: Source;
  to: Source;
  contexts: number;
  duplicateContexts: number;
  drafts: number;
  differentMetadata: boolean;
};
export default function SourceMerge({
  sources,
  initial,
  onClose,
  onDone,
}: {
  sources: Source[];
  initial?: Source;
  onClose: () => void;
  onDone: () => void;
}) {
  const active = sources.filter((s) => s.lifecycle === "active");
  const [fromId, setFromId] = useState(initial?.id || active[0]?.id || "");
  const from = active.find((s) => s.id === fromId);
  const candidates = active.filter(
    (s) => s.id !== fromId && s.type === from?.type,
  );
  const [toId, setToId] = useState(
    candidates.find((s) => normalize(s.title) === normalize(from?.title || ""))
      ?.id ||
      candidates[0]?.id ||
      "",
  );
  const [preview, setPreview] = useState<Preview | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const label = (s: Source) =>
    `${s.title} · ${s.type} · ${s.author || s.date || "未填写作者/日期"} · ${s.expressionCount} 个表达 · ${s.id.slice(-6)}`;
  const reset = () => {
    setPreview(null);
    setConfirmed(false);
    setError("");
  };
  return (
    <Modal
      title="合并来源"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        将原来源内容归入保留来源，再归档原来源。保留义项、笔记与复习历史；不自动合并独立义项。
      </p>
      <ErrorBox error={error} />
      <Field label="原来源（合并后归档）">
        <select
          disabled={busy}
          value={fromId}
          onChange={(e) => {
            const id = e.target.value;
            setFromId(id);
            const s = active.find((x) => x.id === id);
            setToId(
              active.find(
                (x) =>
                  x.id !== id &&
                  x.type === s?.type &&
                  normalize(x.title) === normalize(s.title),
              )?.id ||
                active.find((x) => x.id !== id && x.type === s?.type)?.id ||
                "",
            );
            reset();
          }}
        >
          {active.map((s) => (
            <option key={s.id} value={s.id}>
              {label(s)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="保留来源">
        <select
          disabled={busy}
          value={toId}
          onChange={(e) => {
            setToId(e.target.value);
            reset();
          }}
        >
          <option value="">请选择同类型来源</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {label(s)}
            </option>
          ))}
        </select>
      </Field>
      <button
        className="secondary"
        disabled={busy || !fromId || !toId}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            setPreview(
              await api<Preview>("sources/merge-preview", "POST", {
                fromId,
                toId,
              }),
            );
            setConfirmed(false);
          } catch (e) {
            setError((e as Error).message);
            setPreview(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        预览合并
      </button>
      {preview && (
        <section className="panel">
          <h3>合并预览</h3>
          <p>
            {preview.from.title} → {preview.to.title}
          </p>
          <p>
            迁移 {preview.contexts} 条语境、{preview.drafts} 条草稿；其中{" "}
            {preview.duplicateContexts}{" "}
            条完全相同的有效语境移入回收站。原来源归档，保留来源的作者、日期等资料不变。
          </p>
          {(preview.differentMetadata ||
            normalize(preview.from.title) !== normalize(preview.to.title)) && (
            <p role="alert">
              两来源名称、作者或日期有差异，请确认属于同一材料后再合并。
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              disabled={busy}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我已核对，确认合并并归档原来源
          </label>
          <button
            disabled={busy || !confirmed}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api("sources/merge", "POST", {
                  token: preview.token,
                  confirmed: true,
                });
                onDone();
              } catch (e) {
                setError((e as Error).message);
                setPreview(null);
                setConfirmed(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "正在生成快照并合并…" : "确认合并来源"}
          </button>
        </section>
      )}
    </Modal>
  );
}
