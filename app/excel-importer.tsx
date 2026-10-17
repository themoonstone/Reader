"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/client";
import type { Source } from "@/lib/contracts";
import type {
  ImportPreview,
  ImportChoice,
  ImportResult,
} from "@/lib/import-contracts";
import { ErrorBox, Field } from "./components";

export default function ExcelImporter({
  sources,
  onDone,
}: {
  sources: Source[];
  onDone: (id: string) => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [sourceId, setSourceId] = useState("");
  const [title, setTitle] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [result, setResult] = useState<ImportResult | null>(null);
  const locked = useRef(false);
  const count =
    preview?.groups.reduce(
      (n, g) => n + (choices[g.key]?.action === "skip" ? 0 : g.rows.length),
      0,
    ) || 0;
  async function upload(file: File) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setPreview(null);
    setResult(null);
    setConfirmed(false);
    try {
      if (
        !file.name.toLowerCase().endsWith(".xlsx") ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("请选择不超过 5 MB 的 .xlsx 文件");
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("无法读取文件"));
        reader.readAsDataURL(file);
      });
      const p = await api<ImportPreview>("imports/preview", "POST", {
        fileName: file.name,
        content,
      });
      setPreview(p);
      setTitle(p.suggestedTitle);
      setChoices(
        Object.fromEntries(
          p.groups.map((g) => [
            g.key,
            { groupKey: g.key, action: g.candidates.length ? "skip" : "new" },
          ]),
        ),
      );
      const matches = sources.filter(
        (s) =>
          s.type === "Reading" &&
          s.lifecycle === "active" &&
          s.title.trim().toLowerCase() === p.suggestedTitle.toLowerCase(),
      );
      setSourceId(matches.length === 1 ? matches[0].id : "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      setResult(
        await api<ImportResult>("imports/commit", "POST", {
          token: preview.token,
          sourceId: sourceId || undefined,
          title,
          confirmed,
          choices: Object.values(choices),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">IMPORT YOUR OWN WORDS</span>
          <h1>
            Excel 导入 <span className="heading-translation">仅严格 P1</span>
          </h1>
          <p>保留你已经整理好的内容，先预览，再确认。</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {result ? (
        <section className="panel">
          <h2>导入完成</h2>
          <p className="import-summary" role="status">
            新增 {result.createdExpressions} 个表达，导入{" "}
            {result.importedContexts} 条 P1 语境，跳过已导入{" "}
            {result.skippedContexts} 条。
          </p>
          <p>没有导入 P2/P3，也没有调用 AI。复用的表达保留原有义项。</p>
          <button onClick={() => onDone(result.sourceId)}>
            查看本书的表达 →
          </button>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>01 · 选择表格</h2>
            <p className="muted import-summary">
              支持 Bringing Up Bébé 严格分级表和 Our Little Farm
              章节词汇表。仅解析本机文件；统计表与 P1 汇总表自动跳过。
            </p>
            <Field label="上传 Excel 文件">
              <input
                type="file"
                accept=".xlsx"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = "";
                }}
              />
            </Field>
            {busy && !preview && <p role="status">正在本机检查表格…</p>}
          </section>
          {preview && (
            <>
              <section className="panel import-section">
                <h2>02 · 检查范围与来源</h2>
                <p>已识别：{preview.formatLabel}</p>
                <p className="import-summary" role="status">
                  章节明细 {preview.totalRows} 行：P1 {preview.counts.P1}、P2{" "}
                  {preview.counts.P2}、P3 {preview.counts.P3}。本次仅可导入
                  P1，共 {preview.counts.P1} 条；排除 {preview.excludedRows} 条
                  P2/P3。
                </p>
                <p className="muted">
                  已跳过：{preview.skippedSheets.join("、") || "无汇总表"}。
                </p>
                <div className="form-grid import-summary">
                  <Field label="导入到 Reading 来源">
                    <select
                      disabled={busy}
                      value={sourceId}
                      onChange={(e) => {
                        setSourceId(e.target.value);
                        setConfirmed(false);
                      }}
                    >
                      <option value="">新建书籍来源</option>
                      {sources
                        .filter(
                          (s) =>
                            s.type === "Reading" && s.lifecycle === "active",
                        )
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {!sourceId && (
                    <Field label="新建来源标题">
                      <input
                        value={title}
                        disabled={busy}
                        maxLength={200}
                        onChange={(e) => {
                          setTitle(e.target.value);
                          setConfirmed(false);
                        }}
                      />
                    </Field>
                  )}
                </div>
                <div className="notice">
                  保留原始词条、中文释义与英文语境义。原文与学习改写分开保存，页码缺失留空，节选不补写。原出现次数或合并页码不会额外增加
                  Seen。
                </div>
              </section>
              <section className="panel import-section">
                <h2>03 · 确认义项分组</h2>
                <p className="muted import-summary">
                  按实际词条与相同中文义项分组，共 {preview.groups.length}{" "}
                  组。分组口径与表内去重复习目标不同。每组保留所有语境；若不是同一义项，可选“每行单独保存”。已有同词默认跳过，请明确选择。追加仅支持已有
                  P1，其他等级不会被自动升级。
                </p>
                <div className="import-groups">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={issuesOnly}
                      onChange={(e) => setIssuesOnly(e.target.checked)}
                    />
                    仅查看已有同词 / 等级冲突
                  </label>
                  {preview.groups
                    .filter(
                      (g) =>
                        !issuesOnly ||
                        g.candidates.length > 0 ||
                        g.rows.some(
                          (r) => r.data.importMetadata?.priorityConflict,
                        ),
                    )
                    .map((g) => (
                      <details className="import-group" key={g.key}>
                        <summary>
                          <strong>{g.term}</strong>
                          <span>{g.meaning}</span>
                          <small>
                            {g.rows.length} 条语境
                            {g.rows.some(
                              (r) => r.data.importMetadata?.priorityConflict,
                            )
                              ? " · 等级有差异"
                              : ""}
                            {g.candidates.length ? " · 已有同词" : ""}
                          </small>
                        </summary>
                        <Field label={`${g.term} 的导入方式`}>
                          <select
                            disabled={busy}
                            value={
                              choices[g.key].action === "existing"
                                ? choices[g.key].expressionId
                                : choices[g.key].action
                            }
                            onChange={(e) => {
                              const value = e.target.value;
                              setChoices((c) => ({
                                ...c,
                                [g.key]: {
                                  groupKey: g.key,
                                  action: ["new", "split", "skip"].includes(
                                    value,
                                  )
                                    ? (value as ImportChoice["action"])
                                    : "existing",
                                  expressionId: [
                                    "new",
                                    "split",
                                    "skip",
                                  ].includes(value)
                                    ? undefined
                                    : value,
                                },
                              }));
                              setConfirmed(false);
                            }}
                          >
                            <option value="new">
                              新建此义项，组内语境合并到一条表达
                            </option>
                            <option value="split">
                              每行单独保存为独立义项
                            </option>
                            <option value="skip">本组暂不导入</option>
                            {g.candidates.map((c) => (
                              <option
                                key={c.id}
                                value={c.id}
                                disabled={
                                  c.priority !== "P1" ||
                                  c.lifecycle !== "active"
                                }
                              >
                                追加：{c.meaning} · {c.priority}
                                {c.lifecycle !== "active" ? " · 已归档" : ""}
                              </option>
                            ))}
                          </select>
                        </Field>
                        {g.rows.map((r) => (
                          <article className="import-row" key={r.key}>
                            <p className="eyebrow">
                              {r.sheet} · Excel 第 {r.row} 行
                              {r.data.page ? ` · p. ${r.data.page}` : ""}
                            </p>
                            <blockquote>
                              {r.data.sentence || "未提供原句"}
                            </blockquote>
                            <p>
                              语境解释：
                              {r.data.importMetadata?.contextMeaningEnglish}
                            </p>
                            {r.data.importMetadata?.profile ===
                            "little-farm-v1" ? (
                              <p>
                                简单英文释义 / 学习改写：
                                {r.data.importMetadata.simpleParaphrase}
                              </p>
                            ) : (
                              <p>
                                复习目标：
                                {r.data.importMetadata?.learningTarget}
                              </p>
                            )}
                            <p className="muted">
                              等级理由：{r.data.importMetadata?.rationale}
                            </p>
                            {r.warnings.length > 0 && (
                              <p className="import-warning">
                                {r.warnings.join(" · ")}
                              </p>
                            )}
                          </article>
                        ))}
                      </details>
                    ))}
                </div>
              </section>
              <div className="panel import-section">
                <label className="check import-confirm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已确认所选分组的义项与严格 P1
                  等级，按预览批量入库（不再逐条进入 Inbox）。
                </label>
                <p className="muted">
                  预览 30
                  分钟内有效，服务重启后需重新上传。相同文件明细再次导入同一来源时会跳过已有记录。
                </p>
                <div className="form-actions">
                  <span>已选择 {count} 条 P1 语境</span>
                  <button
                    disabled={
                      busy ||
                      !confirmed ||
                      !count ||
                      (!sourceId && !title.trim())
                    }
                    onClick={() => void commit()}
                  >
                    {busy ? "正在导入…" : `确认导入 ${count} 条 P1`}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
