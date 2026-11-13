import { test, expect, type Page } from "@playwright/test";

async function seed(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "＋ 新建来源", exact: true }).first(),
  ).toBeVisible();
  return page.evaluate(async () => {
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
      if (!r.ok) throw Error(`Seed failed: ${r.status}`);
      return r.json();
    };
    const sourceId = crypto.randomUUID();
    await call("sources", {
      id: sourceId,
      type: "Manual",
      title: `Detail performance E2E ${crypto.randomUUID()}`,
    });
    const term = `read promptly ${crypto.randomUUID()}`;
    const d = await call("drafts", {
      id: crypto.randomUUID(),
      data: {
        term,
        sourceId,
        sourceType: "Manual",
        sentence: "I read this sentence promptly.",
        meaning: "及时阅读",
        priority: "P1",
      },
    });
    const saved = await call(`drafts/${d.id}/save`, { version: d.version });
    return { term, id: saved.expressionId as string };
  });
}
const supporting = /\/api\/(sources|drafts)$/;

test("detail renders before blocked source/Inbox responses; editing waits for fresh sources", async ({
  page,
}) => {
  const item = await seed(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(supporting, async (route) => {
    held++;
    await gate;
    await route.continue();
  });
  try {
    await page.goto(`/#expression/${item.id}`);
    await expect.poll(() => held).toBeGreaterThanOrEqual(2);
    // No elapsed-time threshold: supporting responses cannot finish until released below.
    await expect(
      page.getByRole("heading", { name: item.term, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("I read this sentence promptly.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "编辑表达", exact: true }),
    ).toHaveCount(0);
    release();
    await expect(
      page.getByRole("button", { name: "编辑表达", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
});

test("supporting request failure preserves detail, blocks editing and recovers on retry", async ({
  page,
}) => {
  const item = await seed(page);
  await page.route(supporting, (route) => route.abort());
  await page.goto(`/#expression/${item.id}`);
  await expect(
    page.getByRole("heading", { name: item.term, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("来源信息读取失败，请重试后编辑。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑表达", exact: true }),
  ).toHaveCount(0);
  await page.unroute(supporting);
  await page
    .getByRole("button", { name: "重新连接 / 重试", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: item.term, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑表达", exact: true }),
  ).toBeEnabled();
});
