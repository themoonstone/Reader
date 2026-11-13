import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "我的来源", exact: false }),
  ).toBeVisible();
  return page.evaluate(async () => {
    const { generation } = await fetch("/api/backup/status").then((r) =>
      r.json(),
    );
    const call = async (path: string, body: unknown, method = "POST") => {
      const r = await fetch(`/api/${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": generation,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    };
    const token = `browse-${crypto.randomUUID().slice(0, 8)}`;
    const a = await call("sources", {
      id: crypto.randomUUID(),
      type: "Reading",
      title: `${token} Book`,
    });
    const b = await call("sources", {
      id: crypto.randomUUID(),
      type: "Manual",
      title: `${token} Other`,
    });
    const ids: string[] = [];
    for (let i = 0; i < 18; i++) {
      const source = i < 14 ? a : b;
      const d = await call("drafts", {
        id: crypto.randomUUID(),
        data: {
          term: `${token} term ${i < 2 ? "same" : i}`,
          meaning: `义项 ${i}`,
          sourceId: source.id,
          sourceType: source.type,
          sentence: `${token} original sentence ${i}.`,
          priority: i === 12 || i === 13 ? "P2" : "P1",
        },
      });
      const saved = await call(`drafts/${d.id}/save`, {
        version: d.version,
        newSense: true,
      });
      ids.push(saved.expressionId);
    }
    const e = await fetch(`/api/expressions/${ids[11]}`).then((r) => r.json());
    await call(
      `expressions/${e.id}`,
      { data: e, version: e.version, lifecycle: "archived" },
      "PATCH",
    );
    return { token, sourceId: a.id, title: a.title, ids };
  });
}
const cards = (page: Page) => page.locator("[data-expression-id]");
const navigation = (page: Page) =>
  page.getByRole("navigation", { name: "表达连续浏览" });
const prev = (page: Page) =>
  navigation(page).getByRole("button", { name: "← 上一条", exact: true });
const next = (page: Page) =>
  navigation(page).getByRole("button", { name: "下一条 →", exact: true });
const idsInOrder = (page: Page) =>
  cards(page).evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-expression-id")!),
  );
async function changeLifecycle(
  page: Page,
  id: string,
  action: "archive" | "delete" | "touch",
) {
  await page.evaluate(
    async ({ id, action }) => {
      const { generation } = await fetch("/api/backup/status").then((r) =>
        r.json(),
      );
      const e = await fetch(`/api/expressions/${id}`).then((r) => r.json());
      const r = await fetch(
        `/api/expressions/${id}${action === "delete" ? "/delete" : ""}`,
        {
          method: action === "delete" ? "POST" : "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-ReadWords-Generation": generation,
          },
          body: JSON.stringify(
            action === "delete"
              ? { version: e.version }
              : {
                  data: e,
                  version: e.version,
                  lifecycle: action === "archive" ? "archived" : "active",
                },
          ),
        },
      );
      if (!r.ok) throw Error(await r.text());
    },
    { id, action },
  );
}

for (const width of [1280, 393]) {
  test(`source sequence, stable order, history, reload and return position at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 852 });
    const data = await seed(page);
    await page.goto(`/#source/${data.sourceId}`);
    await expect(cards(page)).toHaveCount(13);
    await page.getByLabel("筛选学习优先级").selectOption("P1");
    await expect(cards(page)).toHaveCount(11);
    const order = await idsInOrder(page);
    await cards(page).nth(8).click();
    await expect(navigation(page)).toContainText("第 9 / 11 条 · 当前来源");
    await next(page).click();
    await expect(page).toHaveURL(new RegExp(`expression/${order[9]}$`));
    await expect(navigation(page)).toContainText("第 10 / 11 条");
    await changeLifecycle(page, order[9], "touch");
    await page.reload();
    await expect(navigation(page)).toContainText("第 10 / 11 条");
    await prev(page).click();
    await expect(navigation(page)).toContainText("第 9 / 11 条");
    await page.goBack();
    await expect(navigation(page)).toContainText("第 10 / 11 条");
    await page.goForward();
    await expect(navigation(page)).toContainText("第 9 / 11 条");
    await page.goBack();
    await expect(navigation(page)).toContainText("第 10 / 11 条");
    await next(page).click();
    await expect(navigation(page)).toContainText("第 11 / 11 条");
    await expect(next(page)).toBeDisabled();
    await page.screenshot({
      path: testInfo.outputPath(`browse-${width}.png`),
      fullPage: false,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await navigation(page)
      .getByRole("button", { name: "← 返回来源列表" })
      .click();
    await expect(page.getByLabel("筛选学习优先级")).toHaveValue("P1");
    const anchor = page.locator(`[data-expression-id="${order[10]}"]`);
    await expect(anchor).toBeFocused();
    await expect(anchor).toBeInViewport();
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(100);
    await anchor.click();
    await expect(navigation(page)).toContainText("第 11 / 11 条");
    await page.goBack();
    await expect(anchor).toBeFocused();
    await expect(anchor).toBeInViewport();
    // A separate/direct link has no unrelated list context.
    const direct = await page.context().newPage();
    await direct.goto(`/#expression/${order[10]}`);
    await expect(navigation(direct)).toContainText("从来源或搜索列表进入");
    await expect(next(direct)).toHaveCount(0);
    await direct.close();
  });
}

test("search keeps every filter, skips changed results, and protects unsaved input", async ({
  page,
}) => {
  const data = await seed(page);
  await page.goto("/#search");
  await page
    .getByRole("textbox", { name: "搜索表达、释义、原句或来源" })
    .fill(data.token);
  await page.getByLabel("筛选来源类型").selectOption("Reading");
  await page.getByLabel("筛选学习优先级").selectOption("P1");
  await page.getByLabel("包含归档表达").check();
  await expect(cards(page)).toHaveCount(12);
  const order = await idsInOrder(page);
  expect(order).toContain(data.ids[0]);
  expect(order).toContain(data.ids[1]);
  await cards(page).first().click();
  await expect(navigation(page)).toContainText("第 1 / 12 条 · 搜索结果");
  await expect(prev(page)).toBeDisabled();
  await page.getByRole("button", { name: "编辑表达", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("义项释义 *", { exact: true }).fill("未保存的修改");
  const leavePrompt = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await (await leavePrompt).dismiss();
  await expect(dialog.getByLabel("义项释义 *", { exact: true })).toHaveValue(
    "未保存的修改",
  );
  await expect(page).toHaveURL(new RegExp(`expression/${order[0]}$`));
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await changeLifecycle(page, order[1], "delete");
  await page.reload();
  await expect(navigation(page)).toContainText("第 1 / 11 条");
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`expression/${order[2]}$`));
  await navigation(page)
    .getByRole("button", { name: "← 返回搜索结果" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "搜索表达、释义、原句或来源" }),
  ).toHaveValue(data.token);
  await expect(page.getByLabel("筛选来源类型")).toHaveValue("Reading");
  await expect(page.getByLabel("筛选学习优先级")).toHaveValue("P1");
  await expect(page.getByLabel("包含归档表达")).toBeChecked();
  await expect(cards(page)).toHaveCount(11);
});

test("list verification cannot block original context; failures retry; missing anchor returns to a neighbor", async ({
  page,
}) => {
  const data = await seed(page);
  await page.goto(`/#source/${data.sourceId}`);
  await expect(cards(page)).toHaveCount(13);
  const order = await idsInOrder(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/idsOnly=1/, async (route) => {
    await gate;
    await route.abort();
  });
  await cards(page).nth(5).click();
  await expect(
    page.getByRole("heading", { name: "原文与出处", exact: true }),
  ).toBeVisible();
  await expect(navigation(page)).toContainText("正在核对浏览列表");
  await expect(next(page)).toBeDisabled();
  release();
  await expect(navigation(page)).toContainText("浏览列表核对失败");
  await page.unroute(/idsOnly=1/);
  await navigation(page).getByRole("button", { name: "重试浏览列表" }).click();
  await expect(navigation(page)).toContainText("第 6 / 13 条");
  await changeLifecycle(page, order[5], "archive");
  await page.reload();
  await expect(navigation(page)).toContainText("当前表达已不在结果中");
  await next(page).click();
  await expect(page).toHaveURL(new RegExp(`expression/${order[6]}$`));
  await changeLifecycle(page, order[6], "delete");
  await navigation(page)
    .getByRole("button", { name: "← 返回来源列表" })
    .click();
  await expect(
    page.locator(`[data-expression-id="${order[7]}"]`),
  ).toBeFocused();
});

test("out-of-order search cannot open old cards; invalid history never inherits a list", async ({
  page,
}) => {
  const data = await seed(page);
  await page.goto("/#search");
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/expressions\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === data.token) {
      held = true;
      await gate;
    }
    await route.continue();
  });
  const input = page.getByRole("textbox", {
    name: "搜索表达、释义、原句或来源",
  });
  try {
    await input.fill(data.token);
    await expect.poll(() => held).toBe(true);
    await expect(cards(page)).toHaveCount(0);
    await input.fill(`${data.token} no-such-result`);
    await expect(
      page.getByText("还没有找到这个表达", { exact: true }),
    ).toBeVisible();
    const oldResponse = page.waitForResponse(
      (r) => new URL(r.url()).searchParams.get("q") === data.token,
    );
    release();
    await oldResponse;
    await expect(cards(page)).toHaveCount(0);
    await input.fill(`${data.token} term same`);
    await expect(cards(page)).toHaveCount(2);
    await cards(page).first().click();
    await expect(navigation(page)).toContainText("第 1 / 2 条");
    await page.evaluate(() =>
      history.replaceState(
        {
          ...history.state,
          readwordsBrowse: { version: 999, origin: "search" },
        },
        "",
      ),
    );
    await page.reload();
    await expect(navigation(page)).toContainText("从来源或搜索列表进入");
    await expect(next(page)).toHaveCount(0);
  } finally {
    release();
  }
});
