"use client";
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, localDate } from "@/lib/client";
import {
  sourceTypes,
  emptyDraft,
  type DraftInput,
  type Source,
  type SourceInput,
  type Draft,
} from "@/lib/contracts";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const control = isValidElement<{ id?: string; "aria-describedby"?: string }>(
    children,
  )
    ? cloneElement(children, {
        id,
        "aria-describedby": hint ? `${id}-hint` : undefined,
      })
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true">
        ✧
      </div>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <header className="modal-header">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="关闭弹窗" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function SourceForm({
  source,
  initialType,
  onSaved,
  onCancel,
}: {
  source?: Source;
  initialType?: SourceInput["type"];
  onSaved: (source: Source) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<SourceInput>(
    () =>
      source || {
        id: crypto.randomUUID(),
        type: initialType || "Reading",
        title:
          initialType === "Writing"
            ? `Journal · ${localDate()}`
            : initialType === "Manual"
              ? "未分类手动记录"
              : "",
        author: "",
        url: "",
        date: initialType === "Writing" ? localDate() : "",
        readingStatus: "reading",
        currentChapter: "",
        format: "",
        duration: "",
      },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof SourceInput, value: unknown) =>
    setData((d) => ({ ...d, [key]: value }));
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const result = await api<Source>(
            source ? `sources/${source.id}` : "sources",
            source ? "PATCH" : "POST",
            source ? { data, version: source.version } : data,
          );
          onSaved(result);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <div className="form-grid">
        <Field label="来源类型">
          <select
            value={data.type}
            disabled={!!source || busy}
            onChange={(e) => {
              const type = e.target.value as SourceInput["type"];
              setData((d) => ({
                ...d,
                type,
                date: type === "Writing" ? localDate() : "",
                title:
                  type === "Writing" && !d.title
                    ? `Journal · ${localDate()}`
                    : d.title,
              }));
            }}
          >
            {sourceTypes.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        <Field label="标题 *">
          <input
            autoFocus
            required
            maxLength={200}
            value={data.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={
              data.type === "Writing"
                ? `Journal · ${localDate()}`
                : "例如：Slow Down"
            }
          />
        </Field>
        {(data.type === "Reading" || data.type === "Listening") && (
          <Field label={data.type === "Reading" ? "作者" : "讲者"}>
            <input
              value={data.author}
              onChange={(e) => set("author", e.target.value)}
            />
          </Field>
        )}
        <Field label="链接（可选）">
          <input
            type="url"
            value={data.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://…"
          />
        </Field>
        {data.type === "Reading" && (
          <>
            <Field label="阅读状态">
              <select
                value={data.readingStatus}
                onChange={(e) => set("readingStatus", e.target.value)}
              >
                <option value="want_to_read">想读</option>
                <option value="reading">在读</option>
                <option value="finished">读完</option>
                <option value="paused">暂停</option>
              </select>
            </Field>
            <Field label="当前章节">
              <input
                value={data.currentChapter}
                onChange={(e) => set("currentChapter", e.target.value)}
              />
            </Field>
          </>
        )}
        {data.type === "Listening" && (
          <>
            <Field label="形式">
              <input
                value={data.format}
                onChange={(e) => set("format", e.target.value)}
                placeholder="Podcast / Video"
              />
            </Field>
            <Field label="总时长（秒，可选）">
              <input
                type="number"
                min="0"
                step="1"
                value={data.duration}
                onChange={(e) =>
                  set(
                    "duration",
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
              />
            </Field>
          </>
        )}
        <Field label="来源日期（可选）">
          <input
            type="date"
            value={data.date}
            onChange={(e) => set("date", e.target.value)}
          />
        </Field>
      </div>
      <footer className="form-actions">
        <button
          type="button"
          className="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          取消
        </button>
        <button disabled={busy}>
          {busy ? "保存中…" : source ? "保存来源" : "创建来源"}
        </button>
      </footer>
    </form>
  );
}
export function Capture({
  sources,
  initialSource,
  onSaved,
  onClose,
  onSourceCreated,
}: {
  sources: Source[];
  initialSource?: Source;
  onSaved: (draft: Draft) => void;
  onClose: () => void;
  onSourceCreated: (source: Source) => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [data, setData] = useState<DraftInput>(() =>
    emptyDraft(initialSource?.type, initialSource?.id),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newSource, setNewSource] = useState(false);
  const close = () => {
    if (
      (!data.term && !data.sentence) ||
      window.confirm("尚未加入 Inbox，确定放弃当前输入？")
    )
      onClose();
  };
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (data.term || data.sentence) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [data]);
  return (
    <Modal title={newSource ? "创建来源" : "记录一个表达"} onClose={close}>
      {newSource ? (
        <SourceForm
          initialType={data.sourceType}
          onCancel={() => setNewSource(false)}
          onSaved={(s) => {
            onSourceCreated(s);
            setData((d) => ({ ...d, sourceId: s.id }));
            setNewSource(false);
          }}
        />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              onSaved(await api<Draft>("drafts", "POST", { id, data }));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="muted">先留下表达，再去 Inbox 慢慢整理。</p>
          <ErrorBox error={error} />
          <div className="type-tabs" role="group" aria-label="采集来源类型">
            {sourceTypes.map((type) => (
              <button
                type="button"
                key={type}
                className={data.sourceType === type ? "selected" : ""}
                onClick={() =>
                  setData((d) => ({
                    ...d,
                    sourceType: type,
                    sourceId: "",
                    eventKind:
                      type === "Writing" ? "output_failed" : "exposure",
                    timestamp: "",
                  }))
                }
              >
                {type}
              </button>
            ))}
          </div>
          <Field label="目标表达 *">
            <input
              autoFocus
              required
              maxLength={200}
              value={data.term}
              onChange={(e) => setData((d) => ({ ...d, term: e.target.value }))}
              placeholder="例如：carve out"
            />
          </Field>
          <Field label="原句（可稍后补充）">
            <textarea
              rows={3}
              maxLength={10000}
              value={data.sentence}
              onChange={(e) =>
                setData((d) => ({ ...d, sentence: e.target.value }))
              }
              placeholder="保留真正遇见这个表达的那句话。"
            />
          </Field>
          <Field label="来源（可稍后补充）">
            <select
              value={data.sourceId}
              onChange={(e) =>
                setData((d) => ({ ...d, sourceId: e.target.value }))
              }
            >
              <option value="">稍后选择来源</option>
              {sources
                .filter(
                  (s) => s.type === data.sourceType && s.lifecycle === "active",
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
            </select>
          </Field>
          <button
            type="button"
            className="text-button"
            onClick={() => setNewSource(true)}
          >
            ＋ 新建 {data.sourceType} 来源
          </button>
          <footer className="form-actions">
            <button
              type="button"
              className="secondary"
              onClick={close}
              disabled={busy}
            >
              取消
            </button>
            <button disabled={busy}>{busy ? "正在保存…" : "加入 Inbox"}</button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
