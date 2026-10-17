import { readFile, writeFile } from "node:fs/promises";
import { userGuide, type GuideSection } from "../lib/user-guide";
const lines = [
  `# ${userGuide.title}`,
  "",
  `更新日期：${userGuide.updatedAt}。内容以网站当前实现为准。`,
  "",
  userGuide.subtitle,
  "",
  userGuide.introduction,
  "",
  "在线阅读：[网站使用指南](http://127.0.0.1:3000/guide)。也可从页面右上角“使用指南”进入。",
  "",
];
const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
for (const section of userGuide.sections as GuideSection[]) {
  lines.push(`## ${section.title}`, "");
  if (section.steps) {
    section.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }
  if (section.paragraphs) {
    for (const p of section.paragraphs) lines.push(p, "");
  }
  if (section.bullets) {
    for (const b of section.bullets) lines.push(`- ${b}`);
    lines.push("");
  }
  if (section.table) {
    lines.push(
      `| ${section.table.headers.map(escape).join(" | ")} |`,
      `| ${section.table.headers.map(() => "---").join(" | ")} |`,
    );
    for (const row of section.table.rows)
      lines.push(`| ${row.map(escape).join(" | ")} |`);
    lines.push("");
  }
}
const output = lines.join("\n");
const path = new URL("../documents/USER_GUIDE.md", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== output) {
    console.error("使用指南文件与网站内容不同，请运行 npm run guide:generate");
    process.exit(1);
  }
  console.log("使用指南网页与 Markdown 内容一致");
} else {
  await writeFile(path, output);
  console.log("已生成 documents/USER_GUIDE.md");
}
