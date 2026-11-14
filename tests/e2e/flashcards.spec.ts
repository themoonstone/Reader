import { test, expect } from "@playwright/test";

test("book flashcards on mobile: scoped P3, highlighter, reveal, skip and no Review writes", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto("/");
  const book = await page.evaluate(async () => {
    const generation = (await fetch("/api/backup/status").then((r) => r.json()))
      .generation;
    async function post(path: string, body: unknown) {
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
    }
    const book = await post("sources", {
      id: crypto.randomUUID(),
      type: "Reading",
      title: "Flashcard Book",
    });
    for (const [term, chapter, priority, sentence, targetSurface] of [
      [
        "go to waste",
        "Chapter 8",
        "P3",
        "All of that effort went to waste.",
        "went to waste",
      ],
      ["light", "Chapter 8", "P3", "", ""],
      ["second chapter", "Chapter 9", "P3", "A second chapter.", ""],
    ]) {
      const d = await post("drafts", {
        id: crypto.randomUUID(),
        data: {
          sourceType: "Reading",
          sourceId: book.id,
          term,
          chapter,
          priority,
          sentence,
          targetSurface,
          meaning: "闪卡测试中文答案",
          page: "12",
        },
      });
      await post(`drafts/${d.id}/save`, { version: d.version, newSense: true });
    }
    return book.id as string;
  });
  const state = () =>
    page.evaluate(async () => {
      const g = await fetch("/api/backup/status").then((r) => r.json());
      const b = await fetch("/api/backup/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": g.generation,
        },
        body: "{}",
      });
      if (!b.ok) throw Error(await b.text());
      const value = await b.json();
      delete value.exported_at;
      return value;
    });
  const before = await state();
  await page.goto(`/#source/${book}`);
  await page.getByRole("button", { name: "翻本书闪卡", exact: true }).click();
  await page.getByLabel("闪卡章节").selectOption(":Chapter 8");
  await page.getByLabel("闪卡等级").selectOption("P1");
  await page.getByRole("button", { name: "开始翻卡", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "书籍闪卡" }).getByRole("alert"),
  ).toContainText("没有可翻的闪卡");
  await page.getByLabel("闪卡等级").selectOption("P3");
  await page.getByRole("button", { name: "开始翻卡", exact: true }).click();
  const card = page.getByRole("article", { name: "当前闪卡" });
  await expect(
    page.getByRole("status").filter({ hasText: "1 / 2" }),
  ).toBeVisible();
  await expect(card.getByText("闪卡测试中文答案")).toHaveCount(0);
  if (
    !(await card
      .getByRole("heading", { name: "go to waste", exact: true })
      .count())
  ) {
    await expect(card).toContainText("没有原句");
    await page.getByRole("button", { name: "跳过", exact: true }).click();
  }
  await expect(card.locator("mark")).toHaveText("went to waste");
  await card.getByRole("heading", { name: "go to waste", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(card).toContainText("闪卡测试中文答案");
  await expect(card).toContainText("Flashcard Book · Chapter 8 · p. 12");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("book-flashcards-393.png"),
    fullPage: true,
  });
  const previous = page.getByRole("button", { name: "上一张", exact: true });
  if (await previous.isEnabled()) {
    await previous.click();
    await expect(card).toContainText("没有原句");
    await page.getByRole("button", { name: "显示释义", exact: true }).click();
    await page.getByRole("button", { name: "下一张", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "下一张", exact: true }).click();
    await expect(card).toContainText("没有原句");
    await previous.click();
    await page.getByRole("button", { name: "跳过", exact: true }).click();
  }
  await expect(card.getByText("闪卡测试中文答案")).toHaveCount(0);
  await page.getByRole("button", { name: "显示释义", exact: true }).click();
  await page.getByRole("button", { name: "结束本轮", exact: true }).click();
  await expect(page.getByLabel("闪卡章节")).toHaveValue(":Chapter 8");

  await page.getByLabel("练习方式").selectOption("cloze");
  await page.getByRole("button", { name: "开始填空", exact: true }).click();
  const question = page.getByRole("article", { name: "当前填空题" });
  const guess = page.getByLabel("填入英语原文");
  const check = page.getByRole("button", { name: "核对原文", exact: true });
  await expect(question.locator("blockquote")).toHaveText(
    "All of that effort ____.",
  );
  await expect(
    question.getByText(/go to waste|went to waste|闪卡测试中文答案/),
  ).toHaveCount(0);
  await expect(question.getByRole("heading")).toBeFocused();
  await expect(check).toBeDisabled();
  await guess.fill("WENT  TO WASTE ");
  await guess.press("Enter");
  await expect(card.getByRole("status")).toHaveText("与原文一致。");
  await expect(card.locator("mark")).toHaveText("went to waste");
  await expect(card).toContainText("Flashcard Book · Chapter 8 · p. 12");
  await expect(card.getByLabel("闪卡答案")).toBeFocused();
  await page.getByRole("button", { name: "下一张", exact: true }).click();
  await expect(card).toContainText("没有原句");
  await expect(page.getByText("这条语境改用普通闪卡。")).toBeVisible();
  await previous.click();
  await expect(guess).toHaveValue("");
  await guess.fill("go to waste");
  await check.click();
  await expect(card.getByRole("status")).toContainText("与原文用词不同");
  await page.getByRole("button", { name: "结束本轮", exact: true }).click();
  await expect(page.getByLabel("练习方式")).toHaveValue("cloze");
  await page.getByRole("button", { name: "开始填空", exact: true }).click();
  await page.setViewportSize({ width: 320, height: 852 });
  await expect(question).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("book-cloze-320.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "显示答案", exact: true }).click();
  await expect(card.getByText("went to waste", { exact: true })).toHaveCount(2);
  await expect(card.getByRole("status")).toHaveCount(0);
  await page.getByRole("button", { name: "结束本轮", exact: true }).click();
  await page.getByRole("button", { name: "← 返回原书", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Flashcard Book", exact: true }),
  ).toBeVisible();
  expect(await state()).toEqual(before);
});
