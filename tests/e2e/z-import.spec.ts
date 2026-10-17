import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const file = resolve(
  "resources/bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx",
);
test("upload real workbook, preview only strict P1, explicitly confirm and inspect imported source", async ({
  page,
}, testInfo) => {
  test.skip(
    !existsSync(file),
    "User-provided workbook is local-only; synthetic parser tests still run.",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "导入 Excel", exact: true }).click();
  await page.getByLabel("上传 Excel 文件", { exact: true }).setInputFiles(file);
  await expect(
    page.getByRole("status").filter({ hasText: "章节明细 1098 行" }),
  ).toBeVisible();
  // Earlier workflow created a P2 "carve out". Import must not silently upgrade it.
  await expect(
    page.getByText("已选择 119 条 P1 语境", { exact: true }),
  ).toBeVisible();
  const conflict = page.locator(".import-group").filter({
    has: page.locator("summary strong").filter({ hasText: /^carve out$/ }),
  });
  await conflict.locator("summary").click();
  await conflict
    .getByLabel("carve out 的导入方式", { exact: true })
    .selectOption("new");
  await expect(
    page.getByText("已选择 120 条 P1 语境", { exact: true }),
  ).toBeVisible();
  const commit = page.getByRole("button", {
    name: "确认导入 120 条 P1",
    exact: true,
  });
  await expect(commit).toBeDisabled();
  await page.locator(".import-group").first().locator("summary").click();
  await expect(page.locator(".import-group").first()).toContainText(
    "groom someone for a role",
  );
  await page.screenshot({
    path: testInfo.outputPath("p1-import-preview.png"),
    fullPage: false,
  });
  await page.getByRole("checkbox", { name: /我已确认所选分组/ }).check();
  await commit.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "新增 112 个表达，导入 120 条 P1 语境" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "查看本书的表达 →", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bringing Up Bébé", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("筛选学习优先级", { exact: true })).toHaveValue(
    "P1",
  );
  await expect(page.getByText("112 个表达", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索表达、释义、原句或来源" })
    .fill("groom");
  await page.getByRole("button", { name: /查看表达 groom ·/ }).click();
  await expect(
    page.getByRole("heading", { name: "groom", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("英文语境释义", { exact: true })).toBeVisible();
  await page.locator(".import-provenance summary").click();
  await expect(page.locator(".import-provenance")).toContainText(
    "groom someone for a role",
  );
  await page.screenshot({
    path: testInfo.outputPath("imported-expression.png"),
    fullPage: false,
  });
});
