import { selectAllSheets } from "./helpers/excel-selection";
import { test, expect } from "@playwright/test";
import ExcelJS from "exceljs";
import { standardHeaders } from "../../lib/standard-import";
for (const width of [1280, 393])
  test(`learning targets highlight safely and invalid templates block before import at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 852 });
    await page.goto("/");
    const original =
      "If you do something for the joy of it, you do it simply for pleasure.";
    const seed = await page.evaluate(async (sentence) => {
      const { generation } = await fetch("/api/backup/status").then((r) =>
        r.json(),
      );
      const call = async (path: string, body: unknown) => {
        const r = await fetch("/api/" + path, {
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
      const src = await call("sources", {
        id: crypto.randomUUID(),
        type: "Listening",
        title: "Highlight " + crypto.randomUUID(),
      });
      const d = await call("drafts", {
        id: crypto.randomUUID(),
        data: {
          sourceId: src.id,
          sourceType: "Listening",
          term: "for the joy of it",
          meaning: "纯粹出于乐趣",
          priority: "P1",
          sentence,
        },
      });
      return call(`drafts/${d.id}/save`, {
        version: d.version,
        newSense: true,
      });
    }, original);
    await page.goto("/#expression/" + seed.expressionId);
    const primary = page.getByRole("region", {
      name: "原文与出处",
      exact: true,
    });
    await expect(primary.locator("blockquote")).toHaveText(original);
    await expect(primary.locator("mark strong")).toHaveText(
      "for the joy of it",
    );
    expect(
      await primary
        .locator("mark strong")
        .evaluate((e) => getComputedStyle(e).fontWeight),
    ).toBe("700");
    await page.screenshot({
      path: info.outputPath(`highlight-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
    const before = await page.evaluate(() =>
      fetch("/api/sources").then((r) => r.json()),
    );
    const title = "Standard UI " + crypto.randomUUID();
    const book = new ExcelJS.Workbook(),
      sh = book.addWorksheet("语料填写");
    sh.addRow(standardHeaders);
    sh.addRow([
      "have it in for someone",
      "存心针对某人",
      title,
      "Chapter 1",
      "12",
      "She had it in for him.",
      "had it in for him",
      1,
      "已核对完整句",
      "P1",
      "He has it in for me.",
      "他在针对我。",
      "自编",
      "have it in for someone",
      "",
    ]);
    sh.getCell("G2").value = "not found";
    const upload = page.getByLabel("上传 Excel 文件", { exact: true });
    await upload.setInputFiles({
      name: "invalid.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await book.xlsx.writeBuffer()),
    });
    await selectAllSheets(page);
    await expect(page.locator(".error[role=alert]")).toContainText("第 2 行");
    await expect(page.locator(".error[role=alert]")).toContainText(
      "高亮出现序号",
    );
    await expect(
      page.getByRole("button", { name: /确认导入 \d+ 条 P1/ }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() => fetch("/api/sources").then((r) => r.json())),
    ).toEqual(before);
    sh.getCell("G2").value = "had it in for him";
    await upload.setInputFiles({
      name: "valid.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await book.xlsx.writeBuffer()),
    });
    await selectAllSheets(page);
    await expect(
      page.getByText("已识别：PhraseBud v1 标准语料模板", { exact: false }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "对比本次导入", exact: true })
      .click();
    await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
    await page
      .getByRole("button", { name: "确认导入 1 条 P1", exact: true })
      .click();
    await page
      .getByRole("button", { name: "查看本书的表达 →", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "查看表达 have it in for someone · 存心针对某人",
        exact: true,
      })
      .click();
    await expect(
      primary.locator("blockquote").first().locator("mark strong"),
    ).toHaveText("had it in for him");
    await expect(primary).toContainText("语境释义");
    await expect(primary).not.toContainText("英文语境释义");
    await expect(
      primary.getByRole("heading", {
        name: "补充例句（非书中原文）",
        exact: true,
      }),
    ).toBeVisible();
    await expect(primary).toContainText("例句来源：自编");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`standard-${width}.png`),
      fullPage: true,
    });
  });
