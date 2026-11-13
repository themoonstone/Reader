"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { normalize, type Source } from "@/lib/contracts";
import type {
  ImportPreview,
  ImportChoice,
  ImportResult,
  ImportDiff,
  WorkbookInspection,
} from "@/lib/import-contracts";
import { ErrorBox, Field } from "./components";

export default function ExcelImporter({
  sources,
  onDone,
  onDirty,
}: {
  sources: Source[];
  onDone: (id: string, priority: string) => void;
  onDirty: (value: boolean) => void;
}) {
  const [inspection, setInspection] = useState<WorkbookInspection | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<("P1" | "P2" | "P3")[]>(["P1"]);
  const [hasFile, setHasFile] = useState(false);
  const [phase, setPhase] = useState("");
  const requestVersion = useRef(0);
  const fileContent = useRef<{ fileName: string; content: string } | null>(
    null,
  );
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ImportChoice>>({});
  const [sourceId, setSourceId] = useState("");
  const [separateSource, setSeparateSource] = useState(false);
  const [diff, setDiff] = useState<ImportDiff | null>(null);
  const [updates, setUpdates] = useState<
    Record<string, "keep" | "update" | "add">
  >({});
  const invalidate = () => {
    setDiff(null);
    setUpdates({});
    setConfirmed(false);
  };

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
  const previewPriorities = preview?.selection?.priorities || ["P1"];
  const levelLabel = previewPriorities.join("/");
  const eligibleCount = preview
    ? previewPriorities.reduce((n, level) => n + preview.counts[level], 0)
    : 0;
  useEffect(() => {
    const dirty = hasFile && !result;
    onDirty(dirty);
    const guard = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      onDirty(false);
      window.removeEventListener("beforeunload", guard);
    };
  }, [hasFile, result, onDirty]);
  useEffect(
    () => () => {
      requestVersion.current++;
      fileContent.current = null;
    },
    [],
  );
  function resetContent() {
    setPreview(null);
    setChoices({});
    setResult(null);
    setSourceId("");
    setTitle("");
    setSeparateSource(false);
    setIssuesOnly(false);
    invalidate();
  }
  function changeSelection(ids: string[]) {
    if (phase === "commit") return;
    requestVersion.current++;
    locked.current = false;
    setBusy(false);
    setPhase("");
    setSelected(ids);
    setError("");
    resetContent();
  }
  function changePriorities(levels: ("P1" | "P2" | "P3")[]) {
    if (phase === "commit") return;
    changeSelection(selected);
    setPriorities(
      ["P1", "P2", "P3"].filter((p) =>
        levels.includes(p as "P1" | "P2" | "P3"),
      ) as ("P1" | "P2" | "P3")[],
    );
  }
  async function upload(file: File) {
    if (phase === "commit") return;
    const version = ++requestVersion.current;
    locked.current = true;
    setBusy(true);
    setPhase("inspect");
    setError("");
    resetContent();
    setInspection(null);
    setSelected([]);
    setPriorities(["P1"]);
    fileContent.current = null;
    setHasFile(false);
    try {
      if (
        !file.name.toLowerCase().endsWith(".xlsx") ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("请选择不超过 5 MB 的 .xlsx 文件");
      setHasFile(true);
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("无法读取文件"));
        reader.readAsDataURL(file);
      });
      if (version !== requestVersion.current) return;
      fileContent.current = { fileName: file.name, content };
      const info = await api<WorkbookInspection>(
        "imports/inspect",
        "POST",
        fileContent.current,
      );
      if (version === requestVersion.current) setInspection(info);
    } catch (e) {
      if (version === requestVersion.current) setError((e as Error).message);
    } finally {
      if (version === requestVersion.current) {
        locked.current = false;
        setBusy(false);
        setPhase("");
      }
    }
  }
  function acceptPreview(p: ImportPreview) {
    setPreview(p);
    setTitle(p.suggestedTitle);
    setChoices(
      Object.fromEntries(
        p.groups.map((g) => [
          g.key,
          (() => {
            const matches = g.candidates.filter(
              (c) =>
                c.lifecycle === "active" &&
                (p.selection?.priorities !== undefined ||
                  c.priority === "P1") &&
                normalize(c.meaning) === normalize(g.meaning),
            );
            return matches.length === 1
              ? {
                  groupKey: g.key,
                  action: "existing" as const,
                  expressionId: matches[0].id,
                }
              : {
                  groupKey: g.key,
                  action: g.candidates.length
                    ? ("skip" as const)
                    : ("new" as const),
                };
          })(),
        ]),
      ),
    );
    const matches = sources.filter(
      (s) =>
        s.type === "Reading" &&
        s.lifecycle === "active" &&
        normalize(s.title) === normalize(p.suggestedTitle),
    );
    setSourceId(matches.length === 1 ? matches[0].id : "");
  }
  async function checkSelected() {
    if (
      locked.current ||
      !fileContent.current ||
      !inspection ||
      !selected.length ||
      !priorities.length
    )
      return;
    const version = ++requestVersion.current;
    locked.current = true;
    setBusy(true);
    setPhase("preview");
    setError("");
    resetContent();
    try {
      const p = await api<ImportPreview>("imports/preview", "POST", {
        ...fileContent.current,
        mode: "selected-sheets-v1",
        inspectionToken: inspection.inspectionToken,
        selectedSheetIds: selected,
        priorities,
      });
      if (version === requestVersion.current) acceptPreview(p);
    } catch (e) {
      if (version === requestVersion.current) setError((e as Error).message);
    } finally {
      if (version === requestVersion.current) {
        locked.current = false;
        setBusy(false);
        setPhase("");
      }
    }
  }
  async function reinspect() {
    if (!fileContent.current || phase === "commit") return;
    const file = fileContent.current,
      version = ++requestVersion.current;
    locked.current = true;
    setBusy(true);
    setPhase("inspect");
    resetContent();
    setSelected([]);
    setPriorities(["P1"]);
    setError("");
    setInspection(null);
    try {
      const info = await api<WorkbookInspection>(
        "imports/inspect",
        "POST",
        file,
      );
      if (version === requestVersion.current) setInspection(info);
    } catch (e) {
      if (version === requestVersion.current) setError((e as Error).message);
    } finally {
      if (version === requestVersion.current) {
        locked.current = false;
        setBusy(false);
        setPhase("");
      }
    }
  }
  async function commit() {
    if (!preview || !diff || locked.current) return;
    locked.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    setPhase("commit");
    setError("");
    try {
      const imported = await api<ImportResult>("imports/commit", "POST", {
        token: preview.token,
        sourceId: sourceId || undefined,
        title,
        confirmed,
        choices: Object.values(choices),
        separateSource,
        diffToken: diff.token,
        updates,
      });
      if (version === requestVersion.current) {
        onDirty(false);
        setResult(imported);
      }
    } catch (e) {
      if (version === requestVersion.current) {
        setError((e as Error).message);
        invalidate();
      }
    } finally {
      if (version === requestVersion.current) {
        locked.current = false;
        setBusy(false);
        setPhase("");
      }
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">IMPORT YOUR OWN WORDS</span>
          <h1>
            Excel 导入 <span className="heading-translation">按等级选择</span>
          </h1>
          <p>保留你已经整理好的内容，先选择工作表，再预览、对比和确认。</p>
        </div>
      </div>
      <ErrorBox error={error} />
      {result ? (
        <section className="panel">
          <h2>导入完成</h2>
          <p className="import-summary" role="status">
            新增 {result.createdExpressions} 个表达，导入{" "}
            {result.importedContexts} 条 {levelLabel} 语境，库对比跳过/保留{" "}
            {result.skippedContexts} 条，更新 {result.updatedContexts || 0}{" "}
            条语境，保留 {result.retainedChanges || 0} 项旧内容。
          </p>
          <p>
            文件内重复跳过 {result.fileDuplicateContexts || 0}{" "}
            条，未选择分组跳过 {result.skippedGroupContexts || 0}{" "}
            条。按所选等级保留原始优先级，未调用
            AI，也不会自动加入复习池。复用的表达保留原有义项、优先级、笔记与复习进度；有更新时已保存操作前快照。
          </p>
          <button onClick={() => onDone(result.sourceId, "")}>
            查看本书的表达 →
          </button>
        </section>
      ) : (
        <>
          <section className="panel">
            <h2>01 · 选择表格</h2>
            <p className="muted import-summary">
              支持 PhraseBud v1 标准模板、Bringing Up Bébé 严格分级表和 Our
              Little Farm
              章节词汇表。先清点工作表，再选择本次范围；已选页有错误会阻止本次导入。说明、示例和汇总页不入库。
            </p>
            <Field label="上传 Excel 文件">
              <input
                type="file"
                accept=".xlsx"
                disabled={phase === "commit"}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = "";
                }}
              />
            </Field>
            {phase === "inspect" && <p role="status">正在检查工作表清单…</p>}
            {fileContent.current && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void reinspect()}
              >
                重新检查工作表
              </button>
            )}
          </section>
          {inspection && (
            <section className="panel import-section" aria-label="选择导入等级">
              <h2>02 · 选择范围：等级</h2>
              <p>
                默认仅选 P1；需要全部收藏时选择
                P1、P2、P3。等级沿用原表，收藏不会自动加入复习池。
              </p>
              <div className="actions wrap import-level-options">
                {(["P1", "P2", "P3"] as const).map((level) => (
                  <label className="check" key={level}>
                    <input
                      type="checkbox"
                      aria-label={`导入等级 ${level}`}
                      checked={priorities.includes(level)}
                      disabled={phase === "commit"}
                      onChange={(e) =>
                        changePriorities(
                          e.target.checked
                            ? [...priorities, level]
                            : priorities.filter((p) => p !== level),
                        )
                      }
                    />
                    {level}
                  </label>
                ))}
                <button
                  className="secondary"
                  disabled={phase === "commit"}
                  onClick={() => changePriorities(["P1", "P2", "P3"])}
                >
                  全部等级
                </button>
                <button
                  className="secondary"
                  disabled={phase === "commit" || !priorities.length}
                  onClick={() => changePriorities([])}
                >
                  清空等级
                </button>
              </div>
              <p
                className={priorities.length ? "muted" : "import-warning"}
                role="status"
              >
                {priorities.length
                  ? `已选等级：${priorities.join("/")}`
                  : "至少选择一个等级才能检查内容。"}
              </p>
            </section>
          )}
          {inspection && (
            <section className="panel import-section" aria-label="选择工作表">
              <h2>02 · 选择范围：工作表</h2>
              <p>{inspection.fileName} · 仅检查页信息，内容尚未通过校验。</p>
              <div className="actions wrap">
                <button
                  className="secondary"
                  disabled={phase === "commit"}
                  onClick={() =>
                    changeSelection(
                      inspection.sheets
                        .filter(
                          (s) => s.role === "data" && s.state === "visible",
                        )
                        .map((s) => s.sheetId),
                    )
                  }
                >
                  全选可见数据页
                </button>
                <button
                  className="secondary"
                  disabled={phase === "commit" || !selected.length}
                  onClick={() => changeSelection([])}
                >
                  取消全选
                </button>
              </div>
              <p className="muted" role="status">
                已选 {selected.length} 页，未选数据页{" "}
                {
                  inspection.sheets.filter(
                    (s) => s.role === "data" && !selected.includes(s.sheetId),
                  ).length
                }{" "}
                页；隐藏{" "}
                {inspection.sheets.filter((s) => s.state !== "visible").length}{" "}
                页，排除{" "}
                {inspection.sheets.filter((s) => s.role !== "data").length}{" "}
                页。隐藏数据页须手动勾选。
              </p>
              {!inspection.sheets.some((s) => s.role === "data") && (
                <p className="import-warning">
                  没有可选的数据页，请使用标准模板保留原列名；辅助页中的正式数据需改为普通页名。
                </p>
              )}
              <div className="sheet-list">
                {inspection.sheets.map((s) => (
                  <div className="sheet-item" key={s.sheetId}>
                    <label className="check">
                      <input
                        type="checkbox"
                        aria-label={`选择工作表 ${s.name}`}
                        checked={selected.includes(s.sheetId)}
                        disabled={phase === "commit" || s.role !== "data"}
                        onChange={(e) =>
                          changeSelection(
                            e.target.checked
                              ? [...selected, s.sheetId]
                              : selected.filter((id) => id !== s.sheetId),
                          )
                        }
                      />
                      <strong>{s.name}</strong>
                    </label>
                    <small>
                      {s.state === "visible"
                        ? "可见"
                        : s.state === "hidden"
                          ? "隐藏"
                          : "深度隐藏"}{" "}
                      ·{" "}
                      {s.profile === "phrasebud-v1"
                        ? "标准模板"
                        : s.profile === "bebe-strict-v1"
                          ? "Bringing Up Bébé"
                          : s.profile === "little-farm-v1"
                            ? "Our Little Farm"
                            : "辅助/未知格式"}{" "}
                      ·{" "}
                      {s.estimatedRows === null
                        ? "数据行数待检查"
                        : `估计 ${s.estimatedRows} 行`}
                    </small>
                    <p
                      className={
                        s.headerIssues.length ? "import-warning" : "muted"
                      }
                    >
                      {s.headerIssues.length
                        ? s.headerIssues.join("；")
                        : s.reason}
                    </p>
                  </div>
                ))}
              </div>
              <button
                disabled={busy || !selected.length || !priorities.length}
                onClick={() => void checkSelected()}
              >
                {phase === "preview" ? "正在检查所选内容…" : "检查所选内容"}
              </button>
              <p className="muted">
                只导入选中页的所选等级；未选择和旧文件未出现的已有内容继续保留。已选页的所有等级均须通过格式校验。
              </p>
            </section>
          )}
          {preview && (
            <>
              <section className="panel import-section">
                <h2>03 · 检查范围与来源</h2>
                <p>已识别：{preview.formatLabel}</p>
                {preview.selection && (
                  <>
                    <p>
                      本次范围：
                      {preview.selection.selectedSheets
                        .map((s) => s.name)
                        .join("、")}
                      ；书籍：{preview.selection.book}
                    </p>
                    <p>
                      文件内重复 {preview.selection.fileDuplicateCount}{" "}
                      条，去重后{" "}
                      {preview.groups.reduce((n, g) => n + g.rows.length, 0)}{" "}
                      条唯一 {levelLabel} 语境可选。
                    </p>
                    {!!preview.fileDuplicates?.length && (
                      <details>
                        <summary>查看文件内重复位置</summary>
                        {preview.fileDuplicates.map((d, i) => (
                          <p key={i}>
                            保留 {d.kept.sheet} 第 {d.kept.row} 行；跳过{" "}
                            {d.skipped
                              .map((r) => `${r.sheet} 第 ${r.row} 行`)
                              .join("、")}
                          </p>
                        ))}
                      </details>
                    )}
                    {!eligibleCount && (
                      <p className="import-warning">
                        所选工作表没有所选等级的语境，不会创建来源或写入表达。可调整工作表或等级后重新检查。
                      </p>
                    )}
                  </>
                )}
                <p className="import-summary" role="status">
                  章节明细 {preview.totalRows} 行：P1 {preview.counts.P1}、P2{" "}
                  {preview.counts.P2}、P3 {preview.counts.P3}。本次选择{" "}
                  {levelLabel}，共 {eligibleCount} 条；按等级排除{" "}
                  {preview.excludedRows} 条。
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
                        setSeparateSource(false);
                        invalidate();
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
                            {s.title} ·{" "}
                            {s.author || s.date || "未填写作者/日期"}
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
                          invalidate();
                        }}
                      />
                    </Field>
                  )}
                </div>
                {!sourceId &&
                  sources.some(
                    (s) =>
                      s.type === "Reading" &&
                      normalize(s.title) === normalize(title),
                  ) && (
                    <label className="check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={separateSource}
                        onChange={(e) => {
                          setSeparateSource(e.target.checked);
                          invalidate();
                        }}
                      />
                      确认这是不同材料，明确新建独立同名来源（否则复用已有来源）
                    </label>
                  )}
                <div className="notice">
                  保留原始词条、中文释义与各自语境义。原文与学习改写分开保存，页码缺失留空，节选不补写。原出现次数或合并页码不会额外增加
                  Seen。
                </div>
              </section>
              <section className="panel import-section">
                <h2>04 · 确认义项分组</h2>
                <p className="muted import-summary">
                  按实际词条与相同中文义项分组，共 {preview.groups.length}{" "}
                  组。分组口径与表内去重复习目标不同。每组保留所有语境；若不是同一义项，可选“每行单独保存”。只有唯一、相同中文释义的有效
                  义项默认复用，其他同词仍须明确选择。追加保留已有表达的等级；新建合并义项使用组内最高优先级，各条语境保留原表等级。
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
                              invalidate();
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
                                  (!preview.selection?.priorities &&
                                    c.priority !== "P1") ||
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
                              {r.sheet} · Excel 第 {r.row} 行 ·{" "}
                              {r.data.priority}
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
              <section className="panel import-section">
                <h2>05 · 对比本次导入</h2>
                <p>
                  先对比，再确认。旧文件中本次未出现的内容继续保留；只新增缺失语境，变更默认保留旧值。
                </p>
                <button
                  className="secondary"
                  disabled={busy || !count || !title.trim()}
                  onClick={async () => {
                    if (locked.current) return;
                    locked.current = true;
                    const version = ++requestVersion.current;
                    setBusy(true);
                    setPhase("diff");
                    setError("");
                    invalidate();
                    try {
                      const compared = await api<ImportDiff>(
                        "imports/diff",
                        "POST",
                        {
                          token: preview.token,
                          sourceId: sourceId || undefined,
                          title,
                          separateSource,
                          confirmed: true,
                          choices: Object.values(choices),
                        },
                      );
                      if (version === requestVersion.current) setDiff(compared);
                    } catch (e) {
                      if (version === requestVersion.current)
                        setError((e as Error).message);
                    } finally {
                      if (version === requestVersion.current) {
                        locked.current = false;
                        setBusy(false);
                        setPhase("");
                      }
                    }
                  }}
                >
                  对比本次导入
                </button>
                {diff && (
                  <>
                    <p role="status">
                      新增 {diff.counts.new} 条语境，跳过重复{" "}
                      {diff.counts.duplicate} 条，内容变更 {diff.counts.changed}{" "}
                      条，保护或待核对{" "}
                      {diff.counts.protected + diff.counts.ambiguous} 条。
                    </p>
                    <p>
                      词条相同不代表义项相同。更新只涉及所列语境与导入资料，个人笔记、学习等级、表达义项和复习进度保留。
                    </p>
                    {diff.counts.changed > 0 && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          setUpdates(
                            Object.fromEntries(
                              diff.rows
                                .filter(
                                  (r) => r.selected && r.status === "changed",
                                )
                                .map((r) => [r.key, "update"]),
                            ),
                          );
                          setConfirmed(false);
                        }}
                      >
                        对全部已确认变更采用新语境值
                      </button>
                    )}
                    {diff.rows
                      .filter(
                        (r) =>
                          r.selected &&
                          !["new", "duplicate"].includes(r.status),
                      )
                      .map((r) => (
                        <details
                          className="import-group"
                          key={r.key}
                          open={r.status === "changed"}
                        >
                          <summary>
                            {r.term} ·{" "}
                            {r.status === "changed"
                              ? "内容变更"
                              : "保留并待核对"}
                          </summary>
                          <p>{r.reason}</p>
                          {r.fields.map((f) => (
                            <div key={f.field}>
                              <strong>{diffFieldLabel(f.field)}</strong>
                              <p>原值：{f.before || "（空）"}</p>
                              <p>新值：{f.after || "（空）"}</p>
                            </div>
                          ))}
                          {["changed", "ambiguous"].includes(r.status) && (
                            <Field
                              label={`${r.term} 第 ${preview.groups.flatMap((g) => g.rows).find((x) => x.key === r.key)?.row} 行变更处理`}
                            >
                              <select
                                disabled={busy}
                                value={updates[r.key] || "keep"}
                                onChange={(e) => {
                                  setUpdates((u) => ({
                                    ...u,
                                    [r.key]: e.target.value as
                                      "keep" | "update" | "add",
                                  }));
                                  setConfirmed(false);
                                }}
                              >
                                <option value="keep">保留旧记录</option>
                                {r.status === "changed" && (
                                  <option value="update">
                                    确认采用新语境值
                                  </option>
                                )}
                                <option value="add">
                                  新增为独立义项语境（本组需选择新建）
                                </option>
                              </select>
                            </Field>
                          )}
                        </details>
                      ))}
                  </>
                )}
              </section>
              <div className="panel import-section">
                <label className="check import-confirm">
                  <input
                    type="checkbox"
                    disabled={busy || !diff}
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  我已确认所选分组的义项与 {levelLabel}
                  等级，按预览批量入库（不再逐条进入 Inbox）。
                </label>
                <p className="muted">
                  预览 30
                  分钟内有效，服务重启后需重新上传。重新导入会先对比，重复记录跳过，变更默认保留旧值。来源或词条变化后需要重新对比。
                </p>
                <div className="form-actions">
                  <div>
                    <span>
                      已选择 {count} 条 {levelLabel} 语境
                    </span>
                    <small className="muted">
                      未选择分组跳过{" "}
                      {preview.groups.reduce((n, g) => n + g.rows.length, 0) -
                        count}{" "}
                      条
                    </small>
                  </div>
                  <button
                    disabled={
                      busy ||
                      !confirmed ||
                      !diff ||
                      !count ||
                      (!sourceId && !title.trim())
                    }
                    onClick={() => void commit()}
                  >
                    {busy ? "正在导入…" : `确认导入 ${count} 条 ${levelLabel}`}
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

function diffFieldLabel(field: string) {
  const labels: Record<string, string> = {
    priority: "语境等级",
    targetSurface: "原句实际词形",
    highlightOccurrence: "高亮出现序号",
    verificationStatus: "原文状态",
    example: "补充例句",
    exampleChinese: "例句中文",
    exampleSource: "例句来源",
    sentence: "原句",
    chapter: "章节",
    page: "页码",
    meaning: "语境释义",
    dictionaryChinese: "导入词典中文义",
    contextMeaningEnglish: "导入英文语境义",
    dictionaryEnglish: "导入词典英文义",
    simpleParaphrase: "学习改写",
    ipa: "音标",
    partOfSpeech: "词性",
    rationale: "等级理由",
    learningTarget: "复习目标",
    originalPriority: "表内原等级",
    normalizedItem: "表内规范词条",
    bookCount: "表内出现次数",
    priorityConflict: "表内等级差异",
    excerpt: "原句节选标记",
    sourceMark: "表内来源标记",
    rawSourceLocation: "表内原始位置",
  };
  return labels[field.replace(/^导入\./, "")] || "导入资料";
}
