import { test, expect } from "@playwright/test";

test("Source → capture → autosaved Inbox → save → search → refresh detail", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "＋ 新建来源", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题 *", { exact: true }).fill("Slow Down · E2E");
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Slow Down · E2E", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("library.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "＋ 记录表达", exact: true }).click();
  await dialog.getByLabel("目标表达 *", { exact: true }).fill("carve out");
  await dialog
    .getByLabel("原句（可稍后补充）", { exact: true })
    .fill("I carve out some time every morning.");
  await dialog
    .getByLabel("来源（可稍后补充）", { exact: true })
    .selectOption({ label: "Slow Down · E2E" });
  await dialog.getByRole("button", { name: "加入 Inbox", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "carve out", exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前语境释义 *", { exact: true }).fill("专门腾出时间");
  await page.getByLabel("页码 / 电子位置", { exact: true }).fill("12");
  await expect(
    page.getByRole("status").filter({ hasText: "草稿已保存" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("当前语境释义 *", { exact: true })).toHaveValue(
    "专门腾出时间",
  );
  await page.getByRole("button", { name: "确认入库 →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "每一次真实接触" }),
  ).toBeVisible();
  await expect(
    page.getByText("I carve out some time every morning.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("p. 12", { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("expression.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "carve out", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "← 返回表达库", exact: true }).click();
  await page
    .getByRole("textbox", { name: "搜索表达、释义、原句或来源" })
    .fill("腾出");
  await expect(
    page.getByRole("heading", { name: "carve out", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /查看表达 carve out/ }).click();
  await expect(
    page.getByRole("heading", { name: "每一次真实接触" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("writing correction preserves original evidence and Used stays zero; Mac reflow", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "＋ 记录表达", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Writing", exact: true }).click();
  await dialog
    .getByLabel("目标表达 *", { exact: true })
    .fill("drain my energy");
  await dialog.getByRole("button", { name: "＋ 新建 Writing 来源" }).click();
  await dialog.getByLabel("标题 *", { exact: true }).fill("Journal · E2E");
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await dialog.getByRole("button", { name: "加入 Inbox", exact: true }).click();
  await page.getByLabel("当前语境释义 *", { exact: true }).fill("消耗我的精力");
  await page
    .getByLabel("事件类型", { exact: true })
    .selectOption("output_corrected");
  await page.getByLabel("原表达", { exact: true }).fill("cost my energy");
  await page.getByLabel("改进表达", { exact: true }).fill("drain my energy");
  await page
    .getByLabel("完整改进句", { exact: true })
    .fill("The commute drains my energy.");
  await page.getByRole("button", { name: "确认入库 →", exact: true }).click();
  await expect(page.locator(".correction")).toContainText("cost my energy");
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Used" })
      .locator("strong"),
  ).toHaveText("0");
  await page.setViewportSize({ width: 1024, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 640, height: 400 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
