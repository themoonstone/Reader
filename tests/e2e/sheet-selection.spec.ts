import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { standardHeaders } from "../../lib/standard-import";
import { standardRow } from "../fixtures/sheet-workbooks";
import { selectAllSheets } from "./helpers/excel-selection";
const mimeType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const picker = (page: Page) =>
  page.getByRole("region", { name: "选择工作表", exact: true });
async function makeFile(book: string, edit?: (w: ExcelJS.Workbook) => void) {
  const w = new ExcelJS.Workbook();
  for (const chapter of [7, 8, 9]) {
    const term = `learn ${book} ${chapter}`;
    w.addWorksheet(`Chapter ${chapter}`).addRows([
      standardHeaders,
      standardRow(term, `Chapter ${chapter}`, book),
    ]);
  }
  w.addWorksheet("Hidden", { state: "veryHidden" }).addRows([
    standardHeaders,
    standardRow(`hidden ${book}`, "Chapter 10", book),
  ]);
  w.addWorksheet("填写说明").addRow(["说明"]);
  w.addWorksheet("Empty");
  edit?.(w);
  return {
    name: "chapters.xlsx",
    mimeType,
    buffer: Buffer.from(await w.xlsx.writeBuffer()),
  };
}
async function sourceData(page: Page, sourceId: string) {
  return page.evaluate(
    async (id) =>
      fetch(`/api/expressions?sourceId=${id}&archived=1`).then((r) => r.json()),
    sourceId,
  );
}
async function confirm(page: Page, count: number) {
  await page.getByRole("button", { name: "对比本次导入", exact: true }).click();
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  await page
    .getByRole("button", { name: `确认导入 ${count} 条 P1`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "导入完成", exact: true }),
  ).toBeVisible();
}
for (const width of [1280, 393])
  test(`choose chapter 8, then all, repeat without duplicates or changing old chapters at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    const book = `Sheet-${crypto.randomUUID().slice(0, 8)}`;
    const seed = new ExcelJS.Workbook();
    seed
      .addWorksheet("语料填写")
      .addRows([
        standardHeaders,
        standardRow(`learn ${book} 7`, "Chapter 7", book),
      ]);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "我的来源", exact: false }),
    ).toBeVisible();
    const sourceId = await page.evaluate(
      async ({ content }) => {
        const { generation } = await fetch("/api/backup/status").then((r) =>
          r.json(),
        );
        const call = async (path: string, body: unknown) => {
          const r = await fetch(`/api/${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-ReadWords-Generation": generation,
            },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw Error(await r.text());
          return r.json();
        };
        const p = await call("imports/preview", {
          fileName: "old.xlsx",
          content,
        });
        const o = {
          token: p.token,
          title: p.suggestedTitle,
          confirmed: true,
          choices: p.groups.map((g: { key: string }) => ({
            groupKey: g.key,
            action: "new",
          })),
        };
        const d = await call("imports/diff", o);
        return (await call("imports/commit", { ...o, diffToken: d.token }))
          .sourceId as string;
      },
      {
        content: Buffer.from(await seed.xlsx.writeBuffer()).toString("base64"),
      },
    );
    const before = await sourceData(page, sourceId);
    await page.reload();
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    const file = await makeFile(book);
    await page
      .getByLabel("上传 Excel 文件", { exact: true })
      .setInputFiles(file);
    await expect(picker(page)).toBeVisible();
    await expect(
      picker(page).getByRole("checkbox", { checked: true }),
    ).toHaveCount(0);
    await expect(
      picker(page).getByRole("button", { name: "检查所选内容", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("选择工作表 填写说明", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("选择工作表 Empty", { exact: true }),
    ).toBeDisabled();
    await page.getByLabel("选择工作表 Chapter 8", { exact: true }).check();
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect(
      page.getByText("已选择 1 条 P1 语境", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("导入到 Reading 来源", { exact: true }),
    ).toHaveValue(sourceId);
    await confirm(page, 1);
    expect((await sourceData(page, sourceId)).length).toBe(2);
    await page
      .getByRole("button", { name: "查看本书的表达 →", exact: true })
      .click();
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    await page
      .getByLabel("上传 Excel 文件", { exact: true })
      .setInputFiles(file);
    await selectAllSheets(page);
    await expect(
      page.getByLabel("选择工作表 Hidden", { exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByText("已选择 3 条 P1 语境", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "对比本次导入", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "新增 1 条语境，跳过重复 2 条" }),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
    await page
      .getByRole("button", { name: "确认导入 3 条 P1", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "导入完成", exact: true }),
    ).toBeVisible();
    const after = await sourceData(page, sourceId);
    expect(after.length).toBe(3);
    expect(after.find((e: { id: string }) => e.id === before[0].id)).toEqual(
      before[0],
    );
    await page
      .getByRole("button", { name: "查看本书的表达 →", exact: true })
      .click();
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    await page
      .getByLabel("上传 Excel 文件", { exact: true })
      .setInputFiles(file);
    await selectAllSheets(page);
    await confirm(page, 3);
    expect(await sourceData(page, sourceId)).toEqual(after);
    await page
      .getByRole("button", { name: "查看本书的表达 →", exact: true })
      .click();
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    await page
      .getByLabel("上传 Excel 文件", { exact: true })
      .setInputFiles(file);
    await expect(picker(page)).toBeVisible();
    await page.getByLabel("选择工作表 Hidden", { exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(
      page.getByLabel("选择工作表 Hidden", { exact: true }),
    ).toBeChecked();
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect(
      page.getByText("已选择 1 条 P1 语境", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`sheets-${width}.png`),
      fullPage: true,
    });
  });

test("selected bad pages block, unselected bad pages do not; range changes clear confirmation and canceling leave keeps input", async ({
  page,
}) => {
  const book = `Errors-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/#import");
  const file = await makeFile(book, (w) => {
    w.getWorksheet("Chapter 9")!.getCell("G2").value = "absent";
    w.addWorksheet("Broken").addRows([["英文词条"], ["broken"]]);
  });
  await page.getByLabel("上传 Excel 文件", { exact: true }).setInputFiles(file);
  await selectAllSheets(page);
  await expect(page.locator(".error[role=alert]")).toContainText("Broken");
  await expect(
    page.getByRole("button", { name: /确认导入 \d+ 条 P1/ }),
  ).toHaveCount(0);
  await page.getByLabel("选择工作表 Broken", { exact: true }).uncheck();
  await picker(page)
    .getByRole("button", { name: "检查所选内容", exact: true })
    .click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Chapter 9 第 2 行",
  );
  await page.getByLabel("选择工作表 Chapter 9", { exact: true }).uncheck();
  await page.getByLabel("选择工作表 Chapter 7", { exact: true }).uncheck();
  await picker(page)
    .getByRole("button", { name: "检查所选内容", exact: true })
    .click();
  await expect(
    page.getByText("已选择 1 条 P1 语境", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "对比本次导入", exact: true }).click();
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  const prompt = page.waitForEvent("dialog");
  const leaving = page
    .getByRole("button", { name: "Library 来源库", exact: true })
    .click();
  await (await prompt).dismiss();
  await leaving;
  await expect(
    page.getByLabel("选择工作表 Chapter 8", { exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /我已确认所选分组/ }),
  ).toBeChecked();
  await page.getByLabel("选择工作表 Chapter 7", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: /确认导入 \d+ 条 P1/ }),
  ).toHaveCount(0);
  await picker(page)
    .getByRole("button", { name: "检查所选内容", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: /我已确认所选分组/ }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "确认导入 2 条 P1", exact: true }),
  ).toBeDisabled();
});

test("late content/diff responses cannot restore an outdated selection", async ({
  page,
}) => {
  const book = `Race-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/#import");
  await page
    .getByLabel("上传 Excel 文件", { exact: true })
    .setInputFiles(await makeFile(book));
  await expect(picker(page)).toBeVisible();
  await page.getByLabel("选择工作表 Chapter 8", { exact: true }).check();
  let release!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/imports/preview", async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect.poll(() => held).toBe(true);
    await page.getByLabel("选择工作表 Chapter 9", { exact: true }).check();
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect(
      page.getByText("已选择 2 条 P1 语境", { exact: true }),
    ).toBeVisible();
    const late = page.waitForResponse("**/api/imports/preview");
    release();
    await late;
    await expect(
      page.getByText("已选择 2 条 P1 语境", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
    await page.unroute("**/api/imports/preview");
  }
  let releaseDiff!: () => void,
    diffHeld = false;
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve;
  });
  await page.route("**/api/imports/diff", async (route) => {
    diffHeld = true;
    await diffGate;
    await route.continue();
  });
  try {
    await page
      .getByRole("button", { name: "对比本次导入", exact: true })
      .click();
    await expect.poll(() => diffHeld).toBe(true);
    await page.getByLabel("选择工作表 Chapter 9", { exact: true }).uncheck();
    const late = page.waitForResponse("**/api/imports/diff");
    releaseDiff();
    await late;
    await expect(
      page.getByRole("button", { name: /确认导入 \d+ 条 P1/ }),
    ).toHaveCount(0);
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect(
      page.getByRole("checkbox", { name: /我已确认所选分组/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /我已确认所选分组/ }),
    ).toBeDisabled();
  } finally {
    releaseDiff();
  }
});

test("late inspection from a previous file cannot replace the new file or its empty selection", async ({
  page,
}) => {
  await page.goto("/#import");
  let release!: () => void,
    held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/imports/inspect", async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  try {
    await page
      .getByLabel("上传 Excel 文件", { exact: true })
      .setInputFiles({ ...(await makeFile("Old file")), name: "old.xlsx" });
    await expect.poll(() => held).toBe(true);
    await page.getByLabel("上传 Excel 文件", { exact: true }).setInputFiles({
      ...(await makeFile("Latest file")),
      name: "latest.xlsx",
    });
    await expect(picker(page)).toContainText("latest.xlsx");
    const late = page.waitForResponse("**/api/imports/inspect");
    release();
    await late;
    await expect(picker(page)).toContainText("latest.xlsx");
    await expect(
      picker(page).getByRole("checkbox", { checked: true }),
    ).toHaveCount(0);
    await page.getByLabel("选择工作表 Chapter 8", { exact: true }).check();
    await picker(page)
      .getByRole("button", { name: "检查所选内容", exact: true })
      .click();
    await expect(
      page.getByText("本次范围：Chapter 8；书籍：Latest file", { exact: true }),
    ).toBeVisible();
  } finally {
    release();
  }
});
