import { selectAllSheets } from "./helpers/excel-selection";
import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { standardHeaders } from "../../lib/standard-import";
const call = async (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const g = (await fetch("/api/backup/status").then((r) => r.json()))
        .generation;
      const r = await fetch("/api/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": g,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { path, body },
  );

test("same-name prompt reuses or explicitly separates sources; merge preview consolidates Library and preserves content", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "＋ 新建来源", exact: true }).first(),
  ).toBeVisible();
  const title = `Merge UI ${crypto.randomUUID()}`;
  const a = await call(page, "sources", {
    id: crypto.randomUUID(),
    type: "Reading",
    title,
  });
  await page.reload();
  await page
    .getByRole("button", { name: "＋ 新建来源", exact: true })
    .first()
    .click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题 *", { exact: true }).fill(title.toUpperCase());
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await expect(dialog.getByLabel("同名来源提示")).toBeVisible();
  await dialog
    .getByRole("button", { name: "使用已有来源", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const count = () =>
    page.evaluate(
      async ({ title }) =>
        (await fetch("/api/sources").then((r) => r.json())).filter(
          (s: { title: string; lifecycle: string }) =>
            s.title.toLowerCase() === title.toLowerCase() &&
            s.lifecycle === "active",
        ).length,
      { title },
    );
  expect(await count()).toBe(1);
  await page
    .getByRole("button", { name: "＋ 新建来源", exact: true })
    .first()
    .click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题 *", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await dialog
    .getByRole("button", { name: "仍然新建独立同名来源", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await count()).toBe(2);
  const b = await page.evaluate(
    async ({ title, id }) =>
      (await fetch("/api/sources").then((r) => r.json())).find(
        (s: { title: string; id: string }) => s.title === title && s.id !== id,
      ),
    { title, id: a.id },
  );
  const d = await call(page, "drafts", {
    id: crypto.randomUUID(),
    data: {
      term: "merge evidence",
      sourceId: b.id,
      sourceType: "Reading",
      sentence: "The original evidence remains.",
      meaning: "保留原始证据",
      priority: "P1",
    },
  });
  await call(page, `drafts/${d.id}/save`, { version: d.version });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.reload();
  await page.getByRole("button", { name: "合并来源", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("原来源（合并后归档）", { exact: true })
    .selectOption(b.id);
  await dialog.getByLabel("保留来源", { exact: true }).selectOption(a.id);
  await dialog.getByRole("button", { name: "预览合并", exact: true }).click();
  await expect(
    dialog.getByText("迁移 1 条语境、1 条草稿", { exact: false }),
  ).toBeVisible();
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1)).toBe(
    true,
  );
  const commit = dialog.getByRole("button", {
    name: "确认合并来源",
    exact: true,
  });
  await expect(commit).toBeDisabled();
  await dialog
    .getByRole("checkbox", {
      name: "我已核对，确认合并并归档原来源",
      exact: true,
    })
    .check();
  await commit.click();
  await expect(dialog).toHaveCount(0);
  expect(await count()).toBe(1);
  const saved = await page.evaluate(
    async ({ id }) => fetch("/api/expressions/" + id).then((r) => r.json()),
    {
      id:
        d.expressionId ||
        (await page.evaluate(
          async ({ id }) =>
            (await fetch("/api/drafts/" + id).then((r) => r.json()))
              .expressionId,
          { id: d.id },
        )),
    },
  );
  expect(saved.contexts[0].sourceId).toBe(a.id);
  expect(saved.contexts[0].data.sentence).toBe(
    "The original evidence remains.",
  );
});

async function file(
  term: string,
  sentence: string,
  meaning: string,
  title: string,
) {
  const w = new ExcelJS.Workbook(),
    s = w.addWorksheet("语料填写");
  s.addRows([
    standardHeaders,
    [
      term,
      "界面增量测试",
      title,
      "Chapter 1",
      "",
      sentence,
      "",
      "",
      "待核对",
      "P1",
      "",
      "",
      "",
      "",
      meaning,
    ],
  ]);
  s.getCell("G2").value = "sentence";
  return {
    name: "incremental.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await w.xlsx.writeBuffer()),
  };
}

test("Excel diff previews changed values and requires confirmation; updated sentence survives repeat import", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const title = `Incremental UI ${crypto.randomUUID()}`,
    term = `delta phrase ${crypto.randomUUID()}`;
  await page.goto("/");
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page
    .getByLabel("上传 Excel 文件", { exact: true })
    .setInputFiles(
      await file(term, "An original sentence.", "original context", title),
    );
  await selectAllSheets(page);
  await page.getByLabel("新建来源标题", { exact: true }).fill(title);
  let commit = page.getByRole("button", {
    name: "确认导入 1 条 P1",
    exact: true,
  });
  await expect(commit).toBeDisabled();
  await page.getByRole("button", { name: "对比本次导入", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "新增 1 条语境，跳过重复 0 条" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  await commit.click();
  await expect(
    page.getByRole("heading", { name: "导入完成", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看本书的表达 →", exact: true })
    .click();
  const sourceId = await page.evaluate(
    async ({ title }) =>
      (await fetch("/api/sources").then((r) => r.json())).find(
        (s: { title: string }) => s.title === title,
      ).id,
    { title },
  );
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page
    .getByLabel("上传 Excel 文件", { exact: true })
    .setInputFiles(
      await file(term, "A corrected sentence.", "corrected context", title),
    );
  await selectAllSheets(page);
  await page
    .getByLabel("导入到 Reading 来源", { exact: true })
    .selectOption(sourceId);
  await page.getByRole("button", { name: "对比本次导入", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "内容变更 1 条" }),
  ).toBeVisible();
  const change = page.getByLabel(`${term} 第 2 行变更处理`, { exact: true });
  await expect(change).toHaveValue("keep");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await change.selectOption("update");
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  await page
    .getByRole("button", { name: "确认导入 1 条 P1", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "更新 1 条语境" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看本书的表达 →", exact: true })
    .click();
  await page.getByRole("heading", { name: term, exact: true }).click();
  await expect(
    page.getByText("A corrected sentence.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".meaning")).toHaveText("界面增量测试");
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page
    .getByLabel("上传 Excel 文件", { exact: true })
    .setInputFiles(
      await file(term, "A corrected sentence.", "corrected context", title),
    );
  await selectAllSheets(page);
  await page
    .getByLabel("导入到 Reading 来源", { exact: true })
    .selectOption(sourceId);
  await page.getByRole("button", { name: "对比本次导入", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "跳过重复 1 条" }),
  ).toBeVisible();
});
