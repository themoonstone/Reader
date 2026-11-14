import { expect, test } from "@playwright/test";

test("book matching retries mistakes, preserves the round scope and writes no learning data", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 852 });
  await page.goto("/");
  const pairs = [
    ["shelter", "避难所"],
    ["take a long walk through the woods", "穿过树林走很长一段路"],
    ["lentils", "扁豆"],
    ["resign", "辞职"],
  ];
  const sourceId = await page.evaluate(async (pairs) => {
    const { generation } = await fetch("/api/backup/status").then((r) =>
      r.json(),
    );
    async function post(path: string, body: unknown) {
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
    }
    const { id } = await post("sources", {
      id: crypto.randomUUID(),
      title: `Pairing book ${crypto.randomUUID()}`,
      type: "Reading",
    });
    for (const [term, meaning, chapter = "Chapter 8", priority = "P3"] of [
      ...pairs,
      ["wrong chapter", "另一章", "Chapter 9"],
      ["wrong level", "另一个等级", "Chapter 8", "P1"],
    ]) {
      const d = await post("drafts", {
        id: crypto.randomUUID(),
        data: {
          sourceType: "Reading",
          sourceId: id,
          term,
          meaning,
          chapter,
          priority,
        },
      });
      await post(`drafts/${d.id}/save`, { version: d.version, newSense: true });
    }
    return id as string;
  }, pairs);
  const backup = () =>
    page.evaluate(async () => {
      const { generation } = await fetch("/api/backup/status").then((r) =>
        r.json(),
      );
      const response = await fetch("/api/backup/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": generation,
        },
        body: "{}",
      });
      if (!response.ok) throw Error(await response.text());
      const data = await response.json();
      delete data.exported_at;
      return data;
    });
  const before = await backup();
  await page.goto(`/#source/${sourceId}`);
  await page.getByRole("button", { name: "翻本书闪卡", exact: true }).click();
  await page.getByLabel("练习方式").selectOption("match");
  const start = page.getByRole("button", { name: "开始配对", exact: true });
  await page.getByLabel("闪卡章节").selectOption(":Chapter 9");
  await start.click();
  await expect(
    page
      .getByRole("region", { name: "书籍闪卡", exact: true })
      .getByRole("alert"),
  ).toContainText("未能凑出 4 对");
  await page.getByLabel("闪卡章节").selectOption(":Chapter 8");
  await page.getByLabel("闪卡等级").selectOption("P3");
  await page.getByLabel("本轮最多几对").selectOption("6");
  await start.click();
  const board = page.getByRole("region", { name: "英中配对", exact: true });
  const status = board.getByRole("status");
  const english = board.getByRole("group", { name: "英文", exact: true });
  const chinese = board.getByRole("group", { name: "中文释义", exact: true });
  await expect(english.getByRole("button")).toHaveCount(4);
  await expect(chinese.getByRole("button")).toHaveCount(4);
  const bottomChoice = (await chinese
    .getByRole("button")
    .last()
    .boundingBox())!;
  const endRound = page.getByRole("button", { name: "结束本轮", exact: true });
  expect((await endRound.boundingBox())!.y).toBeGreaterThanOrEqual(
    bottomChoice.y + bottomChoice.height,
  );
  await expect(
    board.getByRole("heading", { name: "英中配对", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("matching-320.png"),
    fullPage: true,
  });
  const shelter = english.getByRole("button", { name: "shelter", exact: true });
  await shelter.press("Space");
  await expect(shelter).toHaveAttribute("aria-pressed", "true");
  await chinese.getByRole("button", { name: "扁豆", exact: true }).click();
  await expect(status).toContainText("不匹配");
  await expect(status).toContainText("0 / 4");
  await chinese
    .getByRole("button", { name: "避难所", exact: true })
    .press("Enter");
  await shelter.press("Enter");
  await expect(status).toContainText("1 / 4");
  await expect(
    english.getByRole("button", { name: "shelter（已配对）", exact: true }),
  ).toBeDisabled();
  for (const [term, meaning] of pairs.slice(1)) {
    await english.getByRole("button", { name: term, exact: true }).click();
    await chinese.getByRole("button", { name: meaning, exact: true }).click();
  }
  await expect(
    page.getByRole("heading", { name: "本轮配对完成", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "重选范围", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "翻本书闪卡", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("闪卡章节")).toHaveValue(":Chapter 8");
  await expect(page.getByLabel("本轮最多几对")).toHaveValue("6");
  await start.click();
  await expect(status).toContainText("0 / 4");
  await page.getByRole("button", { name: "结束本轮", exact: true }).click();
  expect(await backup()).toEqual(before);
});
