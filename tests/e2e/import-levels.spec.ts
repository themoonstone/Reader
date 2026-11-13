import { test, expect, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { standardHeaders } from "../../lib/standard-import";
import type { Expression } from "../../lib/contracts";
import type { ReviewPool } from "../../lib/review-contracts";
import { standardRow } from "../fixtures/sheet-workbooks";
import { selectAllSheets } from "./helpers/excel-selection";

type Level = "P1" | "P2" | "P3";
const sheetPicker = (page: Page) =>
  page.getByRole("region", { name: "选择工作表", exact: true });
const levelPicker = (page: Page) =>
  page.getByRole("region", { name: "选择导入等级", exact: true });
const confirmation = (page: Page) =>
  page.getByRole("checkbox", { name: /我已确认所选分组/ });
const compare = (page: Page) =>
  page.getByRole("button", { name: "对比本次导入", exact: true });
const check = (page: Page) =>
  sheetPicker(page).getByRole("button", {
    name: "检查所选内容",
    exact: true,
  });

async function fileFor(
  book: string,
  terms: Record<Level, string> = {
    P1: `first ${book}`,
    P2: `second ${book}`,
    P3: `third ${book}`,
  },
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Chapter 1");
  sheet.addRow(standardHeaders);
  for (const level of ["P1", "P2", "P3"] as const) {
    const row = standardRow(terms[level], "Chapter 1", book);
    row[9] = level;
    sheet.addRow(row);
  }
  return {
    name: "levels.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  };
}
async function upload(page: Page, file: Awaited<ReturnType<typeof fileFor>>) {
  await page.getByLabel("上传 Excel 文件", { exact: true }).setInputFiles(file);
  await expect(levelPicker(page)).toBeVisible();
}
async function get<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (url) => {
    const response = await fetch(`/api/${url}`);
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, path);
}
async function sourceId(page: Page, book: string) {
  const sources = await get<{ id: string; title: string }[]>(page, "sources");
  const found = sources.filter((s) => s.title === book);
  expect(found).toHaveLength(1);
  return found[0].id;
}
async function expressions(page: Page, id: string) {
  return get<Expression[]>(page, `expressions?sourceId=${id}`);
}
async function commit(page: Page, count: number, levels: string) {
  await compare(page).click();
  await confirmation(page).check();
  await page
    .getByRole("button", {
      name: `确认导入 ${count} 条 ${levels}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "导入完成", exact: true }),
  ).toBeVisible();
}
async function viewBook(page: Page) {
  await page
    .getByRole("button", { name: "查看本书的表达 →", exact: true })
    .click();
  await expect(page.getByLabel("筛选学习优先级", { exact: true })).toHaveValue(
    "",
  );
}
async function reopen(page: Page) {
  await viewBook(page);
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
}
async function chooseOnly(page: Page, level: Level) {
  await levelPicker(page)
    .getByRole("button", { name: "清空等级", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: `导入等级 ${level}`, exact: true })
    .check();
}
async function seedCandidates(page: Page, terms: Record<Level, string>) {
  return page.evaluate(
    async ({ terms }) => {
      const { generation } = await fetch("/api/backup/status").then((r) =>
        r.json(),
      );
      const call = async (path: string, body: unknown) => {
        const response = await fetch(`/api/${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ReadWords-Generation": generation,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(await response.text());
        return response.json();
      };
      const ids: Record<string, string> = {};
      const source = await call("sources", {
        id: crypto.randomUUID(),
        type: "Manual",
        title: `Earlier senses ${crypto.randomUUID()}`,
      });
      // Incoming P2/P3 contexts deliberately have a different grade from the saved sense.
      for (const [incoming, existing] of [
        ["P2", "P3"],
        ["P3", "P2"],
      ] as const) {
        const draft = await call("drafts", {
          id: crypto.randomUUID(),
          data: {
            sourceType: "Manual",
            sourceId: source.id,
            term: terms[incoming],
            meaning: "腾出时间",
            sentence: `An earlier use of ${terms[incoming]}.`,
            priority: existing,
            note: `personal ${existing} note`,
          },
        });
        ids[incoming] = (
          await call(`drafts/${draft.id}/save`, {
            version: draft.version,
            newSense: true,
          })
        ).expressionId;
      }
      return ids;
    },
    { terms },
  );
}

for (const width of [1280, 393]) {
  test(`default P1 then all grades adds only missing P2/P3, lists all, and does not join Review at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    const book = `Levels-${crypto.randomUUID().slice(0, 8)}`;
    const file = await fileFor(book);
    await page.goto("/#import");
    const poolBefore = await get<ReviewPool>(page, "review/pool");
    await upload(page, file);
    await expect(
      page.getByRole("checkbox", { name: "导入等级 P1", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "导入等级 P2", exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "导入等级 P3", exact: true }),
    ).not.toBeChecked();
    await selectAllSheets(page);
    await expect(
      page.getByText("已选择 1 条 P1 语境", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "按等级排除 2 条" }),
    ).toBeVisible();
    await commit(page, 1, "P1");
    const id = await sourceId(page, book);
    const first = await expressions(page, id);
    expect(first).toHaveLength(1);
    expect(first[0].priority).toBe("P1");
    await reopen(page);
    await upload(page, file);
    await levelPicker(page)
      .getByRole("button", { name: "全部等级", exact: true })
      .click();
    await page.screenshot({
      path: info.outputPath(`level-selection-${width}.png`),
      fullPage: true,
    });
    await selectAllSheets(page);
    await expect(
      page.getByText("已选择 3 条 P1/P2/P3 语境", { exact: true }),
    ).toBeVisible();
    await compare(page).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "新增 2 条语境，跳过重复 1 条" }),
    ).toBeVisible();
    await confirmation(page).check();
    await page
      .getByRole("button", { name: "确认导入 3 条 P1/P2/P3", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "导入完成", exact: true }),
    ).toBeVisible();
    const all = await expressions(page, id);
    expect(all).toHaveLength(3);
    expect(all.map((e) => e.priority).sort()).toEqual(["P1", "P2", "P3"]);
    expect(all.find((e) => e.id === first[0].id)).toEqual(first[0]);
    for (const expression of all) {
      expect(expression.contexts).toHaveLength(1);
      expect(expression.contexts[0].data.priority).toBe(expression.priority);
      expect(expression.contexts[0].data.importMetadata?.originalPriority).toBe(
        expression.priority,
      );
    }
    expect(await get<ReviewPool>(page, "review/pool")).toEqual(poolBefore);
    await viewBook(page);
    await expect(
      page.getByRole("heading", { name: book, exact: true }),
    ).toBeVisible();
    for (const expression of all)
      await expect(
        page.getByRole("button", {
          name: `查看表达 ${expression.term} · ${expression.meaning}`,
          exact: true,
        }),
      ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`all-levels-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    await upload(page, file);
    await levelPicker(page)
      .getByRole("button", { name: "全部等级", exact: true })
      .click();
    await selectAllSheets(page);
    await compare(page).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "新增 0 条语境，跳过重复 3 条" }),
    ).toBeVisible();
    await confirmation(page).check();
    await page
      .getByRole("button", { name: "确认导入 3 条 P1/P2/P3", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "导入完成", exact: true }),
    ).toBeVisible();
    expect(await expressions(page, id)).toEqual(all);
  });

  test(`single P2/P3 preserves existing sense grades and level changes invalidate confirmed previews at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 852 });
    const book = `Reuse-${crypto.randomUUID().slice(0, 8)}`;
    const terms: Record<Level, string> = {
      P1: `one ${book}`,
      P2: `two ${book}`,
      P3: `three ${book}`,
    };
    const file = await fileFor(book, terms);
    await page.goto("/#import");
    const ids = await seedCandidates(page, terms);
    const originals = await Promise.all([
      get<Expression>(page, `expressions/${ids.P2}`),
      get<Expression>(page, `expressions/${ids.P3}`),
    ]);
    const poolBefore = await get<ReviewPool>(page, "review/pool");
    await upload(page, file);
    await chooseOnly(page, "P2");
    await selectAllSheets(page);
    await expect(
      page.getByText("已选择 1 条 P2 语境", { exact: true }),
    ).toBeVisible();
    const p2Group = page.locator(".import-group").filter({
      has: page.locator("summary strong").filter({ hasText: terms.P2 }),
    });
    await p2Group.locator("summary").click();
    await expect(
      p2Group.getByLabel(`${terms.P2} 的导入方式`, { exact: true }),
    ).toHaveValue(ids.P2);
    await compare(page).click();
    await confirmation(page).check();
    await expect(
      page.getByRole("button", { name: "确认导入 1 条 P2", exact: true }),
    ).toBeEnabled();
    await levelPicker(page)
      .getByRole("button", { name: "清空等级", exact: true })
      .click();
    await expect(levelPicker(page).getByRole("status")).toHaveText(
      "至少选择一个等级才能检查内容。",
    );
    await expect(check(page)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /确认导入 \d+ 条/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: "选择工作表 Chapter 1", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("checkbox", { name: "导入等级 P3", exact: true })
      .check();
    await check(page).click();
    await expect(
      page.getByText("已选择 1 条 P3 语境", { exact: true }),
    ).toBeVisible();
    await expect(confirmation(page)).not.toBeChecked();
    await expect(confirmation(page)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "确认导入 1 条 P3", exact: true }),
    ).toBeDisabled();
    await commit(page, 1, "P3");
    const id = await sourceId(page, book);
    let rows = await expressions(page, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(ids.P3);
    expect(rows[0].priority).toBe("P2");
    expect(rows[0].contexts.find((c) => c.sourceId === id)?.data.priority).toBe(
      "P3",
    );
    await viewBook(page);
    await expect(
      page.getByRole("button", {
        name: `查看表达 ${terms.P3} · 腾出时间`,
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    await upload(page, file);
    await chooseOnly(page, "P2");
    await selectAllSheets(page);
    await commit(page, 1, "P2");
    rows = await expressions(page, id);
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.id === ids.P2)?.priority).toBe("P3");
    expect(
      rows.find((e) => e.id === ids.P2)?.contexts.find((c) => c.sourceId === id)
        ?.data.priority,
    ).toBe("P2");
    for (const original of originals) {
      const after = await get<Expression>(page, `expressions/${original.id}`);
      expect(after.priority).toBe(original.priority);
      expect(after.meaning).toBe(original.meaning);
      expect(
        after.contexts.find((c) => c.id === original.contexts[0].id),
      ).toEqual(original.contexts[0]);
    }
    expect(await get<ReviewPool>(page, "review/pool")).toEqual(poolBefore);
    await viewBook(page);
    await expect(
      page.getByRole("button", {
        name: `查看表达 ${terms.P2} · 腾出时间`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `查看表达 ${terms.P3} · 腾出时间`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("late preview and diff responses cannot restore grades changed while requests were pending", async ({
  page,
}) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/#import");
  await upload(
    page,
    await fileFor(`Level-race-${crypto.randomUUID().slice(0, 8)}`),
  );
  await page
    .getByRole("checkbox", { name: "选择工作表 Chapter 1", exact: true })
    .check();
  let releasePreview!: () => void;
  let previewHeld = false;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  await page.route("**/api/imports/preview", async (route) => {
    if (!previewHeld) {
      previewHeld = true;
      await previewGate;
    }
    await route.continue();
  });
  try {
    await check(page).click();
    await expect.poll(() => previewHeld).toBe(true);
    await chooseOnly(page, "P2");
    await check(page).click();
    await expect(
      page.getByText("已选择 1 条 P2 语境", { exact: true }),
    ).toBeVisible();
    const late = page.waitForResponse("**/api/imports/preview");
    releasePreview();
    await late;
    await expect(
      page.getByText("已选择 1 条 P2 语境", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "导入等级 P1", exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "导入等级 P2", exact: true }),
    ).toBeChecked();
  } finally {
    releasePreview();
    await page.unroute("**/api/imports/preview");
  }
  let releaseDiff!: () => void;
  let diffHeld = false;
  const diffGate = new Promise<void>((resolve) => {
    releaseDiff = resolve;
  });
  await page.route("**/api/imports/diff", async (route) => {
    diffHeld = true;
    await diffGate;
    await route.continue();
  });
  try {
    await compare(page).click();
    await expect.poll(() => diffHeld).toBe(true);
    await chooseOnly(page, "P3");
    await check(page).click();
    await expect(
      page.getByText("已选择 1 条 P3 语境", { exact: true }),
    ).toBeVisible();
    const late = page.waitForResponse("**/api/imports/diff");
    releaseDiff();
    await late;
    await expect(
      page.getByText("已选择 1 条 P3 语境", { exact: true }),
    ).toBeVisible();
    await expect(confirmation(page)).not.toBeChecked();
    await expect(confirmation(page)).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "确认导入 1 条 P3", exact: true }),
    ).toBeDisabled();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "新增 1 条语境，跳过重复 0 条" }),
    ).toHaveCount(0);
  } finally {
    releaseDiff();
    await page.unroute("**/api/imports/diff");
  }
});
