"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import {
  eventLabels,
  events,
  reasonLabels,
  reasons,
  expressionSchema,
  type Context,
  type DraftInput,
  type Expression,
  type Source,
} from "@/lib/contracts";
import { ErrorBox, Field, Modal } from "./components";

type Props = {
  expression: Expression;
  sources: Source[];
  onDone: (id?: string) => void;
  onDirty: (value: boolean) => void;
};
export default function Maintenance({
  expression: e,
  sources,
  onDone,
  onDirty,
}: Props) {
  const [editing, setEditing] = useState<"expression" | Context | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(
    path: string,
    version: number,
    message: string,
    next?: string,
  ) {
    if (busy || !window.confirm(message)) return;
    setBusy(true);
    setError("");
    try {
      await api(path, "POST", { version });
      onDone(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="maintenance panel">
      <h2>维护已保存数据</h2>
      <ErrorBox error={error} />
      <div className="actions wrap">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setEditing("expression")}
        >
          编辑表达
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api(`expressions/${e.id}`, "PATCH", {
                version: e.version,
                data: e,
                lifecycle: e.lifecycle === "active" ? "archived" : "active",
              });
              onDone(e.id);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {e.lifecycle === "active" ? "归档表达" : "取消归档"}
        </button>
        <button
          className="secondary danger"
          disabled={busy}
          onClick={() =>
            void action(
              `expressions/${e.id}/delete`,
              e.version,
              "移入回收站？该表达下有效语境会一起移入，之后可以恢复。",
            )
          }
        >
          表达移入回收站
        </button>
      </div>
      <p className="muted">
        状态：
        {e.lifecycle === "archived"
          ? "已归档（搜索时勾选包含归档表达）"
          : "正常"}
        。表达释义与每次语境释义分别维护，不会自动互相覆盖。
      </p>
      {!e.contexts.length && (
        <p>无上下文：表达仍保留，可再次记录或从下方恢复语境。</p>
      )}
      <div className="maintenance-list">
        {e.contexts.map((c) => (
          <div className="maintenance-row" key={c.id}>
            <span>
              {c.sourceTitle} · {c.data.sentence || c.data.meaning}
            </span>
            <div className="actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setEditing(c)}
                aria-label={`编辑语境 ${c.data.sentence || c.data.meaning}`}
              >
                编辑语境 / 归属
              </button>
              <button
                className="text-button danger"
                disabled={busy}
                onClick={() =>
                  void action(
                    `contexts/${c.id}/delete`,
                    c.version,
                    "将这条语境移入回收站？相关计数会减少，可以恢复。",
                    e.id,
                  )
                }
              >
                删除语境
              </button>
            </div>
          </div>
        ))}
      </div>
      {e.deletedContexts.length > 0 && (
        <details>
          <summary>语境回收站（{e.deletedContexts.length}）</summary>
          {e.deletedContexts.map((c) => (
            <div className="maintenance-row" key={c.id}>
              <span>
                {c.sourceTitle} · {c.data.sentence || c.data.meaning}
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(
                    `contexts/${c.id}/restore`,
                    c.version,
                    "恢复这条语境？计数会重新计算。",
                    e.id,
                  )
                }
              >
                恢复语境
              </button>
            </div>
          ))}
        </details>
      )}
      {editing && (
        <SavedEditor
          key={typeof editing === "string" ? e.id : editing.id}
          expression={e}
          context={typeof editing === "string" ? undefined : editing}
          sources={sources}
          onDirty={onDirty}
          onClose={() => setEditing(null)}
          onDone={(id) => {
            setEditing(null);
            onDone(id);
          }}
        />
      )}
    </section>
  );
}
function SavedEditor({
  expression: e,
  context: c,
  sources,
  onDirty,
  onClose,
  onDone,
}: {
  expression: Expression;
  context?: Context;
  sources: Source[];
  onDirty: (v: boolean) => void;
  onClose: () => void;
  onDone: (id: string) => void;
}) {
  const [exp, setExp] = useState(() => expressionSchema.parse(e));
  const [data, setData] = useState<DraftInput | undefined>(c?.data);
  const [target, setTarget] = useState(e.id);
  const [targets, setTargets] = useState<Expression[]>([e]);
  const [duplicate, setDuplicate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dirty = c
    ? JSON.stringify(data) !== JSON.stringify(c.data) || target !== e.id
    : JSON.stringify(exp) !== JSON.stringify(expressionSchema.parse(e));
  useEffect(() => {
    onDirty(dirty);
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      window.removeEventListener("beforeunload", guard);
      onDirty(false);
    };
  }, [dirty, onDirty]);
  useEffect(() => {
    if (c)
      api<Expression[]>("expressions?archived=1")
        .then(setTargets)
        .catch((err) => setError((err as Error).message));
  }, [c]);
  const close = () => {
    if (!busy && (!dirty || window.confirm("尚未保存修改，确定放弃？")))
      onClose();
  };
  const set = (key: keyof DraftInput, value: unknown) =>
    setData((old) => ({ ...old!, [key]: value }));
  return (
    <Modal title={c ? "编辑已保存语境" : "编辑已保存表达"} onClose={close}>
      <ErrorBox error={error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            if (c)
              await api(`contexts/${c.id}`, "PATCH", {
                version: c.version,
                data,
                expressionId: target,
                allowDuplicate: duplicate,
              });
            else
              await api(`expressions/${e.id}`, "PATCH", {
                version: e.version,
                data: exp,
              });
            onDirty(false);
            onDone(target);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy} className="editor-fields">
          {!c ? (
            <>
              <Field label="表达 *">
                <input
                  required
                  maxLength={200}
                  value={exp.term}
                  onChange={(ev) => setExp({ ...exp, term: ev.target.value })}
                />
              </Field>
              <Field label="义项释义 *">
                <textarea
                  required
                  maxLength={1000}
                  value={exp.meaning}
                  onChange={(ev) =>
                    setExp({ ...exp, meaning: ev.target.value })
                  }
                />
              </Field>
              <Field label="学习优先级">
                <select
                  value={exp.priority}
                  onChange={(ev) =>
                    setExp({
                      ...exp,
                      priority: ev.target.value as typeof exp.priority,
                    })
                  }
                >
                  {["P1", "P2", "P3"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="表达类型">
                <select
                  value={exp.type}
                  onChange={(ev) =>
                    setExp({ ...exp, type: ev.target.value as typeof exp.type })
                  }
                >
                  {[
                    "word",
                    "phrase",
                    "collocation",
                    "chunk",
                    "sentence_pattern",
                  ].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </Field>
              <Field label="简单替换">
                <input
                  maxLength={1000}
                  value={exp.alternative}
                  onChange={(ev) =>
                    setExp({ ...exp, alternative: ev.target.value })
                  }
                />
              </Field>
              <p className="muted">
                改名不会合并同形义项，也不会重写历史原句。确认这些语境仍属于此义项。
              </p>
            </>
          ) : (
            data && (
              <>
                <Field label="归属表达 / 义项">
                  <select
                    value={target}
                    onChange={(ev) => setTarget(ev.target.value)}
                  >
                    {targets.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.term} · {x.meaning} · {x.priority}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="来源 *">
                  <select
                    value={data.sourceId}
                    onChange={(ev) => {
                      const s = sources.find((x) => x.id === ev.target.value)!;
                      setData({
                        ...data,
                        sourceId: s.id,
                        sourceType: s.type,
                        eventKind:
                          s.type === "Writing" ? "output_failed" : "exposure",
                        whySaved: "useful",
                        timestamp: "",
                        timestampSeconds: null,
                      });
                    }}
                  >
                    {sources
                      .filter(
                        (s) => s.lifecycle === "active" || s.id === c.sourceId,
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.type} · {s.title}
                          {s.lifecycle === "archived" ? "（已归档）" : ""}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="事件类型">
                  <select
                    value={data.eventKind}
                    onChange={(ev) => set("eventKind", ev.target.value)}
                  >
                    {events
                      .filter((k) =>
                        ["Reading", "Listening"].includes(data.sourceType)
                          ? k === "exposure"
                          : data.sourceType === "Writing"
                            ? k !== "exposure"
                            : k !== "output_corrected",
                      )
                      .map((k) => (
                        <option key={k} value={k}>
                          {eventLabels[k]}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="原句">
                  <textarea
                    maxLength={10000}
                    value={data.sentence}
                    onChange={(ev) => set("sentence", ev.target.value)}
                  />
                </Field>
                <Field label="语境释义 *">
                  <textarea
                    required
                    maxLength={1000}
                    value={data.meaning}
                    onChange={(ev) => set("meaning", ev.target.value)}
                  />
                </Field>
                <div className="form-grid">
                  {(
                    [
                      ["chapter", "章节", 200],
                      ["page", "页码 / 电子位置", 100],
                      ["targetSurface", "实际出现形式", 200],
                    ] as const
                  ).map(([key, label, max]) => (
                    <Field label={label} key={key}>
                      <input
                        maxLength={max}
                        value={data[key]}
                        onChange={(ev) => set(key, ev.target.value)}
                      />
                    </Field>
                  ))}
                </div>
                {data.sourceType === "Listening" && (
                  <>
                    <Field label="时间位置">
                      <input
                        placeholder="03:42 或 01:03:42"
                        value={data.timestamp}
                        onChange={(ev) => set("timestamp", ev.target.value)}
                      />
                    </Field>
                    <Field label="误听内容">
                      <input
                        maxLength={1000}
                        value={data.misheard}
                        onChange={(ev) => set("misheard", ev.target.value)}
                      />
                    </Field>
                  </>
                )}
                {data.sourceType === "Writing" && (
                  <>
                    {(
                      [
                        ["originalExpression", "原表达", 200],
                        ["correctedExpression", "改进表达", 200],
                        ["correctedSentence", "完整改进句", 10000],
                        ["intendedMeaning", "想表达的意思", 1000],
                      ] as const
                    ).map(([key, label, max]) => (
                      <Field label={label} key={key}>
                        <textarea
                          maxLength={max}
                          value={data[key]}
                          onChange={(ev) => set(key, ev.target.value)}
                        />
                      </Field>
                    ))}
                  </>
                )}
                <Field label="真实接触日期">
                  <input
                    type="date"
                    value={data.occurredOn}
                    onChange={(ev) => set("occurredOn", ev.target.value)}
                  />
                </Field>
                <Field label="保存原因">
                  <select
                    value={data.whySaved}
                    onChange={(ev) => set("whySaved", ev.target.value)}
                  >
                    {reasons
                      .filter(
                        (r) =>
                          r !== "misheard" || data.sourceType === "Listening",
                      )
                      .map((r) => (
                        <option key={r} value={r}>
                          {reasonLabels[r]}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="备注">
                  <textarea
                    maxLength={3000}
                    value={data.note}
                    onChange={(ev) => set("note", ev.target.value)}
                  />
                </Field>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={duplicate}
                    onChange={(ev) => setDuplicate(ev.target.checked)}
                  />
                  如与目标表达已有事件相同，我确认这是另一次记录
                </label>
                <p className="muted">
                  只移动这一条语境，不改目标表达的等级和义项。Excel
                  原始元数据保留，不随编辑覆盖。
                </p>
              </>
            )
          )}
        </fieldset>
        <div className="actions">
          <button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存修改"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            取消
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Trash({ onDone }: { onDone: (id: string) => void }) {
  const [items, setItems] = useState<Expression[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Expression[]>("trash")
      .then(setItems)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <section className="panel">
      <h2>表达回收站</h2>
      <p>
        不永久清空。恢复表达时，仅恢复随本次表达删除的语境；此前单独删除的语境仍留在该表达的语境回收站。
      </p>
      <ErrorBox error={error} />
      {!items.length && <p>回收站为空。</p>}
      {items.map((e) => (
        <div className="maintenance-row" key={e.id}>
          <span>
            {e.term} · {e.meaning}
          </span>
          <button
            className="secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`expressions/${e.id}/restore`, "POST", {
                  version: e.version,
                });
                onDone(e.id);
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            恢复表达
          </button>
        </div>
      ))}
    </section>
  );
}
