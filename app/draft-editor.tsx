"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, RequestError } from "@/lib/client";
import {
  sourceTypes,
  normalize,
  reasons,
  reasonLabels,
  events,
  eventLabels,
  type Draft,
  type DraftInput,
  type Source,
  type Expression,
} from "@/lib/contracts";
import { ErrorBox, Field, Modal, SourceForm } from "./components";

export default function DraftEditor({
  draft,
  sources,
  onDone,
  onDirty,
  onSourceCreated,
}: {
  draft: Draft;
  sources: Source[];
  onDone: (expressionId?: string) => void;
  onDirty: (dirty: boolean) => void;
  onSourceCreated: (source: Source) => void;
}) {
  const [data, setData] = useState(draft.data);
  const current = useRef(data);
  current.current = data;
  const version = useRef(draft.version);
  const saved = useRef(JSON.stringify(draft.data));
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const locked = useRef(false);
  const mounted = useRef(true);
  const [status, setStatus] = useState("草稿已保存");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Expression[]>([]);
  const [choice, setChoice] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [newSource, setNewSource] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const persist = useCallback(() => {
    const work = chain.current
      .catch(() => {})
      .then(async () => {
        const snapshot = current.current;
        const json = JSON.stringify(snapshot);
        if (json === saved.current) return;
        if (mounted.current) setStatus("保存中…");
        const result = await api<Draft>(`drafts/${draft.id}`, "PATCH", {
          data: snapshot,
          version: version.current,
        });
        version.current = result.version;
        saved.current = json;
        if (mounted.current) {
          const clean = JSON.stringify(current.current) === saved.current;
          setStatus(clean ? "草稿已保存" : "等待保存…");
          onDirty(!clean);
        }
      });
    chain.current = work;
    return work;
  }, [draft.id, onDirty]);
  useEffect(() => {
    const dirty = JSON.stringify(data) !== saved.current;
    onDirty(dirty);
    if (!dirty || locked.current) return;
    setStatus("等待保存…");
    const timer = setTimeout(() => {
      persist().catch((e) => {
        if (mounted.current) {
          setError((e as Error).message);
          setStatus("保存失败，输入仍保留");
        }
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [data, persist, onDirty]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(current.current) !== saved.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  useEffect(() => {
    let active = true;
    setChoice("");
    setCandidates([]);
    const timer = setTimeout(
      () =>
        api<Expression[]>(`candidates?term=${encodeURIComponent(data.term)}`)
          .then((r) => {
            if (active) setCandidates(r);
          })
          .catch((e) => {
            if (active) setError((e as Error).message);
          }),
      250,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [data.term]);
  const set = (key: keyof DraftInput, value: string) => {
    setData((d) => ({ ...d, [key]: value }));
    setError("");
    setDuplicate(false);
    setAllowDuplicate(false);
  };
  const selected = candidates.find((e) => e.id === choice);
  async function finish(state?: "pending" | "ignored") {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await persist();
      if (state) {
        await api(`drafts/${draft.id}`, "PATCH", {
          data: current.current,
          version: version.current,
          state,
        });
        onDirty(false);
        onDone();
      } else {
        if (candidates.length && !choice)
          throw new Error("请先选择已有义项或明确新建义项");
        const result = await api<{ expressionId: string }>(
          `drafts/${draft.id}/save`,
          "POST",
          {
            version: version.current,
            expressionId: choice && choice !== "new" ? choice : undefined,
            newSense: choice === "new",
            allowDuplicate,
          },
        );
        onDirty(false);
        onDone(result.expressionId);
      }
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof RequestError && e.code === "DUPLICATE_CONTEXT")
        setDuplicate(true);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="editor-heading">
        <div>
          <span className="eyebrow">INBOX / 整理表达</span>
          <h1 className="serif">{data.term || "未命名表达"}</h1>
        </div>
        <span className="save-status" role="status">
          {status}
        </span>
      </div>
      <ErrorBox error={error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void finish();
        }}
      >
        <fieldset
          disabled={busy || draft.state === "ignored"}
          className="editor-fields"
        >
          <div className="editor-columns">
            <section className="panel">
              <div className="section-heading">
                <span className="step">01</span>
                <h2>留下真实语境</h2>
              </div>
              <Field label="目标表达 *">
                <input
                  required
                  maxLength={200}
                  value={data.term}
                  onChange={(e) => set("term", e.target.value)}
                />
              </Field>
              <div className="form-grid">
                <Field label="来源类型">
                  <select
                    value={data.sourceType}
                    onChange={(e) => {
                      const type = e.target.value as DraftInput["sourceType"];
                      setData((d) => ({
                        ...d,
                        sourceType: type,
                        sourceId: "",
                        eventKind:
                          type === "Writing" ? "output_failed" : "exposure",
                        timestamp: "",
                        whySaved: "useful",
                      }));
                    }}
                  >
                    {sourceTypes.map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </Field>
                <Field label="来源 *">
                  <select
                    value={data.sourceId}
                    onChange={(e) => set("sourceId", e.target.value)}
                  >
                    <option value="">请选择来源</option>
                    {sources
                      .filter(
                        (s) =>
                          s.lifecycle === "active" &&
                          s.type === data.sourceType,
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => setNewSource(true)}
              >
                ＋ 新建来源
              </button>
              <Field
                label="原句"
                hint="只填写真正遇见或写下的句子；没有原句也可保存，但部分练习不可用。"
              >
                <textarea
                  rows={4}
                  value={data.sentence}
                  onChange={(e) => set("sentence", e.target.value)}
                  maxLength={10000}
                />
              </Field>
              {data.sourceType === "Reading" && (
                <div className="form-grid">
                  <Field label="章节">
                    <input
                      value={data.chapter}
                      onChange={(e) => set("chapter", e.target.value)}
                    />
                  </Field>
                  <Field label="页码 / 电子位置">
                    <input
                      value={data.page}
                      onChange={(e) => set("page", e.target.value)}
                    />
                  </Field>
                </div>
              )}
              {data.sourceType === "Listening" && (
                <>
                  <Field label="时间位置">
                    <input
                      placeholder="03:42 或 01:03:42"
                      value={data.timestamp}
                      onChange={(e) => set("timestamp", e.target.value)}
                    />
                  </Field>
                  <Field label="误听内容（可选）">
                    <input
                      value={data.misheard}
                      onChange={(e) => set("misheard", e.target.value)}
                    />
                  </Field>
                </>
              )}
              <Field
                label="真实接触日期（可选）"
                hint="不知道就留空，系统会分别显示记录日期。"
              >
                <input
                  type="date"
                  value={data.occurredOn}
                  onChange={(e) => set("occurredOn", e.target.value)}
                />
              </Field>
              <Field label="事件类型">
                <select
                  value={data.eventKind}
                  onChange={(e) => set("eventKind", e.target.value)}
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
              {data.sourceType === "Writing" && (
                <div className="writing-section">
                  <p className="muted">
                    被纠正不等于自主使用，两种经历会分别保留。
                  </p>
                  <div className="form-grid">
                    <Field label="原表达">
                      <input
                        value={data.originalExpression}
                        onChange={(e) =>
                          set("originalExpression", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="改进表达">
                      <input
                        value={data.correctedExpression}
                        onChange={(e) =>
                          set("correctedExpression", e.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <Field label="完整改进句">
                    <textarea
                      rows={3}
                      value={data.correctedSentence}
                      onChange={(e) => set("correctedSentence", e.target.value)}
                    />
                  </Field>
                  <Field label="我想表达的意思">
                    <textarea
                      rows={2}
                      value={data.intendedMeaning}
                      onChange={(e) => set("intendedMeaning", e.target.value)}
                    />
                  </Field>
                </div>
              )}
            </section>
            <section className="panel">
              <div className="section-heading">
                <span className="step">02</span>
                <h2>确定学习价值</h2>
              </div>
              <Field label="当前语境释义 *">
                <textarea
                  rows={3}
                  value={data.meaning}
                  onChange={(e) => set("meaning", e.target.value)}
                  maxLength={1000}
                  placeholder="例如：专门腾出时间"
                />
              </Field>
              <div className="form-grid">
                <Field label="表达类型">
                  <select
                    value={data.expressionType}
                    onChange={(e) => set("expressionType", e.target.value)}
                  >
                    {[
                      "word",
                      "phrase",
                      "collocation",
                      "chunk",
                      "sentence_pattern",
                    ].map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Why saved · 保存原因">
                  <select
                    value={data.whySaved}
                    onChange={(e) => set("whySaved", e.target.value)}
                  >
                    {reasons
                      .filter(
                        (k) =>
                          k !== "misheard" || data.sourceType === "Listening",
                      )
                      .map((k) => (
                        <option key={k} value={k}>
                          {reasonLabels[k]}
                        </option>
                      ))}
                  </select>
                </Field>
              </div>
              <Field label="简单替换（可选）">
                <input
                  value={data.alternative}
                  onChange={(e) => set("alternative", e.target.value)}
                />
              </Field>
              <Field label="原句中的实际词形（可选）">
                <input
                  value={data.targetSurface}
                  onChange={(e) => set("targetSurface", e.target.value)}
                  placeholder="例如：drains my energy"
                />
              </Field>
              <Field label="学习优先级">
                <select
                  value={data.priority}
                  disabled={!!selected}
                  onChange={(e) => set("priority", e.target.value)}
                >
                  <option value="P1">P1 · 希望主动使用</option>
                  <option value="P2">P2 · 认识即可</option>
                  <option value="P3">P3 · 记录即可</option>
                </select>
              </Field>
              {selected && (
                <p className="notice">
                  将追加到已有义项，保持原优先级 {selected.priority}，
                  {selected.lifecycle === "archived"
                    ? "并保留归档状态。"
                    : "不覆盖已有释义。"}
                </p>
              )}
              <Field label="备注">
                <textarea
                  rows={3}
                  value={data.note}
                  onChange={(e) => set("note", e.target.value)}
                />
              </Field>
              <div className="notice">
                本阶段先手动整理。AI
                建议将在后续接入，你的原始材料不会自动发送。
              </div>
              {candidates.length > 0 && (
                <div className="candidate-box">
                  <h3>已记录过这个表达</h3>
                  <p className="muted">
                    同一个义项追加语境，不同含义单独保存。
                  </p>
                  {candidates.map((c) => (
                    <label className="radio-card" key={c.id}>
                      <input
                        type="radio"
                        name="sense"
                        value={c.id}
                        checked={choice === c.id}
                        onChange={() => setChoice(c.id)}
                      />
                      <span>
                        <strong>{c.meaning}</strong>
                        <small>
                          {c.priority} · {c.contextCount} 个语境
                          {c.lifecycle === "archived" ? " · 已归档" : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                  <label className="radio-card">
                    <input
                      type="radio"
                      name="sense"
                      checked={choice === "new"}
                      onChange={() => setChoice("new")}
                    />
                    <span>这是另一个义项，单独新建</span>
                  </label>
                </div>
              )}
              {duplicate && (
                <label className="radio-card">
                  <input
                    type="checkbox"
                    checked={allowDuplicate}
                    onChange={(e) => setAllowDuplicate(e.target.checked)}
                  />
                  确认这是另一次接触，仍然保存
                </label>
              )}
            </section>
          </div>
        </fieldset>
        <div className="editor-footer">
          <div>
            <span className="muted">
              {!data.sentence
                ? "缺少原句：仍可入库，暂不能生成相关练习。"
                : "保存时保留原句与来源。"}
            </span>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                navigator.clipboard
                  .writeText(JSON.stringify(data, null, 2))
                  .then(() => setStatus("当前输入已复制"))
                  .catch(() => setError("无法复制，请手动选择文本复制。"))
              }
            >
              复制当前输入
            </button>
          </div>
          <div className="actions">
            {draft.state === "ignored" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void finish("pending")}
              >
                恢复到 Inbox
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void finish("ignored")}
                >
                  忽略
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    void persist().catch((e) => setError((e as Error).message));
                  }}
                >
                  保存草稿 / 重试
                </button>
                <button disabled={busy}>
                  {busy ? "保存中…" : "确认入库 →"}
                </button>
              </>
            )}
          </div>
        </div>
      </form>
      {newSource && (
        <Modal title="创建来源" onClose={() => setNewSource(false)}>
          <SourceForm
            initialType={data.sourceType}
            onCancel={() => setNewSource(false)}
            onSaved={(s) => {
              onSourceCreated(s);
              set("sourceId", s.id);
              setNewSource(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
