import { test, expect, type Page } from "@playwright/test";
async function seed(page: Page) {
  return page.evaluate(async () => {
    const gen = (await fetch("/api/backup/status").then((r) => r.json()))
      .generation;
    const call = async (path: string, body: unknown) => {
      const r = await fetch("/api/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": gen,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    };
    const source = await call("sources", {
      id: crypto.randomUUID(),
      type: "Reading",
      title: "Review E2E",
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await call("drafts", {
        id: crypto.randomUUID(),
        data: {
          term: `review phrase ${i}`,
          sourceType: "Reading",
          sourceId: source.id,
          sentence: `A real review sentence ${i}.`,
          meaning: `认义测试答案 ${i}`,
          priority: "P1",
        },
      });
      ids.push(
        (await call(`drafts/${d.id}/save`, { version: 1 })).expressionId,
      );
    }
    return ids;
  });
}
test("Review opt-in → hidden answer → reveal → feedback → skip → pause/resume → end; 200% keyboard reflow", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  const ids = await seed(page);
  await page.goto(`/#expression/${ids[0]}`);
  await page.getByRole("button", { name: "加入复习池", exact: true }).click();
  await expect(page.getByText("已加入复习池", { exact: true })).toBeVisible();
  await page.goto("/#review");
  await page.getByRole("button", { name: "选择近期想练的表达" }).click();
  await page.getByLabel("搜索复习候选").fill("review phrase");
  await page
    .getByRole("checkbox", { name: "选择 review phrase 1：认义测试答案 1" })
    .check();
  await page
    .getByRole("checkbox", { name: "选择 review phrase 2：认义测试答案 2" })
    .check();
  await page.getByRole("button", { name: "加入所选表达", exact: true }).click();
  await expect(page.getByText("已加入 3/20", { exact: false })).toBeVisible();
  await page.getByLabel("展示卡数").selectOption("5");
  await page.getByRole("button", { name: "开始本轮练习", exact: true }).click();
  const card = page.getByRole("article", { name: "当前复习卡" });
  await expect(card).toBeVisible();
  await expect(page.getByText("认义测试答案", { exact: false })).toHaveCount(0);
  await expect(page.locator('[aria-label*="认义测试答案"]')).toHaveCount(0);
  await page.getByRole("button", { name: "揭晓答案", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByText("认义测试答案", { exact: false })).toHaveCount(2);
  await page.getByRole("button", { name: "记得", exact: true }).click();
  await page.getByRole("button", { name: "下一张", exact: true }).click();
  await page.getByRole("button", { name: "跳过这张", exact: true }).click();
  await page.getByRole("button", { name: "下一张", exact: true }).click();
  await page.getByRole("button", { name: "暂停练习", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续本轮练习" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "继续本轮练习" }).click();
  await expect(
    page.getByRole("button", { name: "揭晓答案", exact: true }),
  ).toBeEnabled();
  // 640 CSS px represents the available layout at 200% on a 1280 px display.
  await page.setViewportSize({ width: 640, height: 800 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: info.outputPath("review-200-percent-layout.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "今天先到这里", exact: true }).click();
  await expect(page.getByRole("region", { name: "本轮结果" })).toContainText(
    "实际反馈 1 张",
  );
  expect(errors).toEqual([]);
});
test("Review two windows cannot silently steal lease; visibility pause stops writes", async ({
  page,
  context,
}) => {
  await page.goto("/#review");
  await page.getByRole("button", { name: "开始本轮练习", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "揭晓答案", exact: true }),
  ).toBeEnabled();
  const other = await context.newPage();
  await other.goto("/#review");
  await other.getByRole("button", { name: "继续本轮练习" }).click();
  await expect(
    other.getByRole("alert").filter({ hasText: "另一窗口" }),
  ).toContainText("另一窗口");
  await expect(
    other.getByRole("button", { name: "揭晓答案", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("button", { name: "继续本轮练习" }),
  ).toBeVisible();
  await other.getByRole("button", { name: "继续本轮练习" }).click();
  await expect(
    other.getByRole("button", { name: "揭晓答案", exact: true }),
  ).toBeEnabled();
  await other
    .getByRole("button", { name: "今天先到这里", exact: true })
    .click();
  await other.close();
});
