import type { Metadata } from "next";
import { userGuide } from "@/lib/user-guide";

export const metadata: Metadata = {
  title: "使用指南 · ReadWords",
  description:
    "ReadWords 当前版本的中文操作指南：导入 P1、手动记录、Inbox、来源与搜索。",
};
export default function Guide() {
  return (
    <div className="guide-shell">
      <header className="guide-header">
        <a className="guide-brand" href="/#library">
          ReadWords
        </a>
        <a className="guide-action" href="/#library">
          进入我的表达库 →
        </a>
      </header>
      <main className="guide-main">
        <div className="guide-intro">
          <span className="eyebrow">USER GUIDE · {userGuide.updatedAt}</span>
          <h1>{userGuide.title}</h1>
          <p className="guide-subtitle">{userGuide.subtitle}</p>
          <p>{userGuide.introduction}</p>
          <div className="actions">
            <a className="guide-action primary" href="/#import">
              去导入 P1
            </a>
            <a className="guide-action" href="/#library">
              查看已经导入的书
            </a>
          </div>
        </div>
        <nav className="guide-toc" aria-label="指南目录">
          <h2>我想了解…</h2>
          <div>
            {userGuide.sections.map((s) => (
              <a key={s.id} href={`#${s.id}`}>
                {s.title}
              </a>
            ))}
          </div>
        </nav>
        {userGuide.sections.map((section) => (
          <section key={section.id} id={section.id} className="guide-section">
            <h2>{section.title}</h2>
            {"steps" in section && section.steps && (
              <ol>
                {section.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
            {"paragraphs" in section &&
              section.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}
            {"bullets" in section && section.bullets && (
              <ul>
                {section.bullets.map((bullet, i) => (
                  <li key={i}>{bullet}</li>
                ))}
              </ul>
            )}
            {"table" in section && section.table && (
              <div className="guide-table">
                <table>
                  <thead>
                    <tr>
                      {section.table.headers.map((h) => (
                        <th key={h} scope="col">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {section.table.rows.map((row, i) => (
                      <tr key={i}>
                        {row.map((cell, j) => (
                          <td key={j}>{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <a className="guide-top" href="#">
              回到顶部 ↑
            </a>
          </section>
        ))}
      </main>
      <footer className="guide-footer">
        本指南描述已实现的功能；功能更新时同步维护。
      </footer>
    </div>
  );
}
