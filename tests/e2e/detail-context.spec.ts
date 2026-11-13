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
    const term = `carve out ${crypto.randomUUID()}`;
    const source = await call("sources", {
      id: crypto.randomUUID(),
      type: "Reading",
      title: `Context book ${crypto.randomUUID()}`,
    });
    const writing = await call("sources", {
      id: crypto.randomUUID(),
      type: "Writing",
      title: `Context journal ${crypto.randomUUID()}`,
    });
    let id = "";
    for (const data of [
      {
        sourceId: source.id,
        sourceType: "Reading",
        sentence: "We carve out time for a book.",
        chapter: "Chapter 1",
        page: "42",
      },
      {
        sourceId: writing.id,
        sourceType: "Writing",
        sentence: "I make out time to read.",
        eventKind: "output_corrected",
        originalExpression: "make out time",
        correctedExpression: "carve out time",
        correctedSentence: `I carve out time to read. ${"longword".repeat(30)}`,
      },
      {
        sourceId: source.id,
        sourceType: "Reading",
        sentence: "",
        chapter: "Chapter 3",
      },
    ]) {
      const d = await call("drafts", {
        id: crypto.randomUUID(),
        data: { term, meaning: "腾出时间", priority: "P1", ...data },
      });
      id = (
        await call(`drafts/${d.id}/save`, {
          version: d.version,
          ...(id ? { expressionId: id } : {}),
        })
      ).expressionId;
    }
    const before = await fetch(`/api/expressions/${id}`).then((r) => r.json());
    return { id, term, before };
  });
}
async function setDeleted(
  page: Page,
  id: string,
  version: number,
  deleted: boolean,
) {
  return page.evaluate(
    async ({ id, version, deleted }) => {
      const { generation } = await fetch("/api/backup/status").then((r) =>
        r.json(),
      );
      const r = await fetch(
        `/api/contexts/${id}/${deleted ? "delete" : "restore"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-ReadWords-Generation": generation,
          },
          body: JSON.stringify({ version }),
        },
      );
      if (!r.ok) throw Error(await r.text());
      return r.json();
    },
    { id, version, deleted },
  );
}
for (const viewport of [
  { width: 1280, height: 900 },
  { width: 393, height: 852 },
]) {
  test(`original context precedes controls and preserves all records at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const item = await seed(page);
    await page.goto(`/#expression/${item.id}`);
    const primary = page.getByRole("region", {
      name: "原文与出处",
      exact: true,
    });
    const others = page.getByRole("region", {
      name: "其他真实接触",
      exact: true,
    });
    await expect(primary.locator("blockquote").first()).toHaveText(
      "I make out time to read.",
    );
    await expect(primary.locator(".correction blockquote")).toContainText(
      "I carve out time to read.",
    );
    await expect(others.locator(".context-card")).toHaveCount(2);
    await expect(others).toContainText("Chapter 1");
    await expect(others).toContainText("p. 42");
    await expect(others).toContainText("未提供原句");
    // Original is visible on opening; every context occurs once, ahead of editing/stats.
    const quote = (await primary.locator("blockquote").first().boundingBox())!;
    expect(quote.y).toBeGreaterThan(0);
    expect(quote.y + quote.height).toBeLessThan(viewport.height);
    await expect(page.locator(".context-card")).toHaveCount(3);
    await expect(
      page.getByRole("button", { name: "编辑表达", exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(() => {
        const first = document.querySelector('[aria-label="原文与出处"]')!;
        const rest = document.querySelector('[aria-label="其他真实接触"]')!;
        const edit = Array.from(document.querySelectorAll("button")).find(
          (e) => e.textContent === "编辑表达",
        )!;
        const stats = document.querySelector(".stats-row")!;
        return (
          Boolean(
            first.compareDocumentPosition(rest) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          Boolean(
            rest.compareDocumentPosition(edit) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          Boolean(
            rest.compareDocumentPosition(stats) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ) &&
          document.documentElement.scrollWidth <= window.innerWidth
        );
      }),
    ).toBe(true);
    const after = await page.evaluate(
      async (id) => fetch(`/api/expressions/${id}`).then((r) => r.json()),
      item.id,
    );
    expect(after).toEqual(item.before);
    await page.screenshot({
      path: testInfo.outputPath(`original-first-${viewport.width}.png`),
      fullPage: true,
    });
    const corrected = item.before.contexts.find(
      (c: { data: { eventKind: string } }) =>
        c.data.eventKind === "output_corrected",
    );
    const older = item.before.contexts.find(
      (c: { data: { sentence: string } }) =>
        c.data.sentence === "We carve out time for a book.",
    );
    await setDeleted(page, corrected.id, corrected.version, true);
    await page.reload();
    await expect(primary.locator("blockquote")).toHaveText(
      "We carve out time for a book.",
    );
    await setDeleted(page, older.id, older.version, true);
    await page.reload();
    await expect(primary).toContainText("尚未提供原句");
    await expect(primary.locator("blockquote")).toHaveCount(0);
    await expect(others.locator(".context-card")).toHaveCount(1);
    await expect(
      page.getByText("语境回收站（2）", { exact: true }),
    ).toBeVisible();
    await setDeleted(page, corrected.id, corrected.version + 1, false);
    await page.reload();
    await expect(primary.locator("blockquote").first()).toHaveText(
      "I make out time to read.",
    );
    await expect(
      page.getByRole("button", { name: "＋ 再次记录", exact: true }),
    ).toBeEnabled();
  });
}
