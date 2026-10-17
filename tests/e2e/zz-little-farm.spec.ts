import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const file = resolve("resources/Our_Little_Farm_Vocabulary-4.xlsx");
test("Our Little Farm detection, P1 import and metadata preserve the existing book", async ({
  page,
}, testInfo) => {
  test.skip(
    !existsSync(file),
    "User workbook is local-only; synthetic adapter tests still run.",
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const before = await page.evaluate(async () => {
    const sources = (await fetch("/api/sources").then((r) => r.json())) as {
      id: string;
      title: string;
    }[];
    const book = sources.find((s) => s.title === "Bringing Up Bébé");
    return book
      ? {
          id: book.id,
          data: await fetch(
            `/api/expressions?sourceId=${book.id}&archived=1`,
          ).then((r) => r.json()),
        }
      : null;
  });
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page.getByLabel("上传 Excel 文件", { exact: true }).setInputFiles(file);
  await expect(
    page.getByText("已识别：Our Little Farm 章节词汇表", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "章节明细 373 行：P1 50、P2 192、P3 131" }),
  ).toBeVisible();
  await expect(page.getByLabel("新建来源标题", { exact: true })).toHaveValue(
    "Our Little Farm",
  );
  await expect(
    page.getByLabel("导入到 Reading 来源", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByText("已跳过：P1 优先掌握。", { exact: true }),
  ).toBeVisible();
  // Explicitly choose independent senses for this test so existing book meanings are untouched.
  const selects = page.getByLabel(/的导入方式$/);
  expect(await selects.count()).toBe(50);
  for (let i = 0; i < (await selects.count()); i++)
    if ((await selects.nth(i).inputValue()) === "skip") {
      const group = page.locator(".import-group").nth(i);
      await group.locator("summary").click();
      await selects.nth(i).selectOption("new");
    }
  const commit = page.getByRole("button", {
    name: "确认导入 50 条 P1",
    exact: true,
  });
  await expect(commit).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("farm-preview.png"),
    fullPage: false,
  });
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  await commit.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "新增 50 个表达，导入 50 条 P1 语境" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看本书的表达 →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Our Little Farm", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("50 个表达", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索表达、释义、原句或来源" })
    .fill("rule of thumb");
  await page.getByRole("button", { name: /查看表达 rule of thumb ·/ }).click();
  await page.locator(".import-provenance summary").click();
  await expect(page.locator(".import-provenance")).toContainText(
    "简单英文释义 / 学习改写：a rough practical guide",
  );
  await expect(page.locator(".import-provenance")).toContainText(
    "原表来源标记 / 页码：标记",
  );
  await expect(page.locator(".context-card blockquote")).toHaveText(
    "That’s just a rule of thumb, of course.",
  );
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Seen" })
      .locator("strong"),
  ).toHaveText("1");
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Used" })
      .locator("strong"),
  ).toHaveText("0");
  await page.screenshot({
    path: testInfo.outputPath("farm-detail.png"),
    fullPage: false,
  });
  if (before) {
    const after = await page.evaluate(
      async (id) =>
        fetch(`/api/expressions?sourceId=${id}&archived=1`).then((r) =>
          r.json(),
        ),
      before.id,
    );
    expect(after).toEqual(before.data);
  }
  expect(errors).toEqual([]);
});
