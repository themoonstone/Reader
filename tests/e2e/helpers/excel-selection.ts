import { expect, type Page } from "@playwright/test";
export async function selectAllSheets(page: Page) {
  const picker = page.getByRole("region", { name: "选择工作表", exact: true });
  await expect(picker).toBeVisible();
  await picker
    .getByRole("button", { name: "全选可见数据页", exact: true })
    .click();
  await picker
    .getByRole("button", { name: "检查所选内容", exact: true })
    .click();
}
