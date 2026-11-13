import { displayDate } from "@/lib/client";
import { eventLabels, reasonLabels, type Context } from "@/lib/contracts";

import HighlightedText from "./highlighted-text";
export default function ContextCard({
  context: c,
  term,
}: {
  context: Context;
  term: string;
}) {
  const standard = c.data.importMetadata?.profile === "phrasebud-v1";
  return (
    <article className="context-card">
      <div className="section-bar">
        <div>
          <span className={`tag ${c.sourceType.toLowerCase()}`}>
            {c.sourceType}
          </span>
          <strong>{c.sourceTitle}</strong>
        </div>
        <span className="muted">{eventLabels[c.data.eventKind]}</span>
      </div>
      <div className="context-position">
        {[
          c.data.chapter,
          c.data.page ? `p. ${c.data.page}` : "",
          c.data.timestamp,
        ]
          .filter(Boolean)
          .join(" · ") || "位置未提供"}
        　·　
        {c.data.occurredOn
          ? `接触日期 ${c.data.occurredOn}`
          : `记录于 ${displayDate(c.createdAt)}`}
      </div>
      {c.data.sentence ? (
        <blockquote>
          <HighlightedText
            text={c.data.sentence}
            term={term}
            surface={c.data.targetSurface}
            occurrence={c.data.importMetadata?.highlightOccurrence}
          />
        </blockquote>
      ) : (
        <p className="muted">未提供原句</p>
      )}
      <p>
        <span className="muted">
          {c.data.importMetadata && !standard ? "英文语境释义　" : "语境释义　"}
        </span>
        {c.data.meaning}
      </p>
      {standard && (
        <section aria-label="标准模板学习资料">
          <p>原文状态：{c.data.importMetadata!.verificationStatus}</p>
          {c.data.importMetadata!.example && (
            <>
              <h3>补充例句（非书中原文）</h3>
              <blockquote>
                <HighlightedText
                  text={c.data.importMetadata!.example}
                  term={term}
                />
              </blockquote>
              <p>{c.data.importMetadata!.exampleChinese}</p>
              <p className="muted">
                例句来源：{c.data.importMetadata!.exampleSource}
              </p>
            </>
          )}
        </section>
      )}
      {c.data.importMetadata && (
        <details className="import-provenance">
          <summary>
            Excel 导入信息 · {c.data.importMetadata.sheet} 第{" "}
            {c.data.importMetadata.row} 行
          </summary>
          <p>文件：{c.data.importMetadata.fileName}</p>
          <p>
            {standard
              ? "中文语境义："
              : c.data.importMetadata.profile === "little-farm-v1"
                ? "原表中文释义："
                : "词典中文义项："}
            {c.data.importMetadata.dictionaryChinese}
          </p>
          <p>
            {c.data.importMetadata.profile === "little-farm-v1"
              ? "核心英文释义："
              : "词典英文解释："}
            {c.data.importMetadata.dictionaryEnglish}
          </p>
          <p>
            音标（原表记录）：
            {c.data.importMetadata.ipa || "未提供"} · 词性：
            {c.data.importMetadata.partOfSpeech}
          </p>
          {c.data.importMetadata.profile === "little-farm-v1" && (
            <>
              <p>
                原表来源标记 / 页码：
                {c.data.importMetadata.rawSourceLocation || "未提供"}
              </p>
              <p>
                简单英文释义 / 学习改写：
                {c.data.importMetadata.simpleParaphrase || "未提供"}
              </p>
              <p>原表片段按一行记录一次遇见，不按页码数量叠加。</p>
            </>
          )}
          {c.data.importMetadata.learningTarget && (
            <p>
              复习目标或搭配：
              {c.data.importMetadata.learningTarget}
            </p>
          )}
          <p>
            {c.data.importMetadata.profile === "little-farm-v1"
              ? "学习理由："
              : "严格等级理由："}
            {c.data.importMetadata.rationale}
          </p>
          <p>
            原等级：
            {c.data.importMetadata.originalPriority || "未提供"}
            {c.data.importMetadata.bookCount && (
              <>
                {" "}
                · 原表出现次数：
                {c.data.importMetadata.bookCount}（不重复计入 Seen）
              </>
            )}
          </p>
          {c.data.importMetadata.priorityConflict && (
            <p>其他明细含不同等级，本次仅导入严格 P1。</p>
          )}
          {c.data.importMetadata.excerpt && <p>上下文为原表节选，未补写。</p>}
        </details>
      )}
      {c.data.eventKind === "output_corrected" && (
        <div className="correction">
          <p>
            <span>原表达</span>
            {c.data.originalExpression}
          </p>
          <p>
            <span>改进表达</span>
            {c.data.correctedExpression}
          </p>
          {c.data.correctedSentence && (
            <blockquote>
              <HighlightedText text={c.data.correctedSentence} term={term} />
            </blockquote>
          )}
        </div>
      )}
      {c.data.intendedMeaning && <p>想表达：{c.data.intendedMeaning}</p>}
      {c.data.misheard && <p>误听：{c.data.misheard}</p>}
      <footer className="context-reason">
        <span>
          Why saved · {reasonLabels[c.data.whySaved]}
          {c.data.importMetadata ? "（导入默认）" : ""}
        </span>
        {c.data.note && <p>{c.data.note}</p>}
      </footer>
    </article>
  );
}
