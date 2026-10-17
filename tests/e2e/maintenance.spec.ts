import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("saved editing, context counts, recycle bin and JSON snapshot recovery through UI", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  // Isolated E2E service uses a temporary database. Seed via the same guarded API.
  const eid = await page.evaluate(async () => {
    const status = await fetch("/api/backup/status").then((r) => r.json());
    const call = async (path: string, body: unknown) => {
      const r = await fetch("/api/" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ReadWords-Generation": status.generation,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw Error(await r.text());
      return r.json();
    };
    const sid = crypto.randomUUID();
    await call("sources", {
      id: sid,
      type: "Manual",
      title: "Maintenance E2E",
    });
    const d = await call("drafts", {
      id: crypto.randomUUID(),
      data: {
        term: "maintain momentum",
        sourceId: sid,
        sourceType: "Manual",
        meaning: "保持动力",
        sentence: "We maintain momentum.",
      },
    });
    return (await call(`drafts/${d.id}/save`, { version: d.version }))
      .expressionId as string;
  });
  await page.goto(`/#expression/${eid}`);
  await page.getByRole("button", { name: "编辑表达", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("义项释义 *", { exact: true }).fill("持续保持动力");
  await dialog.getByLabel("学习优先级", { exact: true }).selectOption("P1");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".meaning")).toHaveText("持续保持动力");
  await page
    .getByRole("button", {
      name: "编辑语境 We maintain momentum.",
      exact: true,
    })
    .click();
  dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("事件类型", { exact: true })
    .selectOption("output_used");
  await dialog.getByLabel("原句", { exact: true }).fill("I maintain momentum.");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Used" })
      .locator("strong"),
  ).toHaveText("1");
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Seen" })
      .locator("strong"),
  ).toHaveText("0");
  await page.getByRole("button", { name: "删除语境", exact: true }).click();
  await expect(
    page.getByText("无上下文：表达仍保留，可再次记录或从下方恢复语境。"),
  ).toBeVisible();
  await page.getByText("语境回收站（1）", { exact: true }).click();
  await page.getByRole("button", { name: "恢复语境", exact: true }).click();
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Used" })
      .locator("strong"),
  ).toHaveText("1");
  await page.getByRole("button", { name: "归档表达", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消归档", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "表达移入回收站", exact: true })
    .click();
  await page.getByRole("button", { name: /本地工作空间/ }).click();
  await page.getByRole("button", { name: "恢复表达", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "取消归档", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /本地工作空间/ }).click();
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载全库 JSON 备份", exact: true })
    .click();
  const downloaded = await downloadEvent;
  const backup = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
  expect(backup.schema_version).toBe(2);
  expect(backup.expressions.some((e: { id: string }) => e.id === eid)).toBe(
    true,
  );
  // A second window with an old draft must not write after restore, even if IDs/versions match.
  const stale = await page.context().newPage();
  await stale.goto(`/#expression/${eid}`);
  await stale.getByRole("button", { name: "编辑表达", exact: true }).click();
  await stale
    .getByRole("dialog")
    .getByLabel("义项释义 *", { exact: true })
    .fill("旧窗口覆盖");
  await page.getByLabel("选择 JSON 备份", { exact: true }).setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{bad"),
  });
  await expect(page.locator('.error[role="alert"]')).toContainText("有效 JSON");
  await page.getByLabel("选择 JSON 备份", { exact: true }).setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(
    page.getByRole("heading", { name: "恢复预览", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认替换整个学习库", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("backup-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("checkbox", {
      name: "我确认用文件中的数据替换当前整个学习库",
      exact: true,
    })
    .check();
  await page
    .getByRole("button", { name: "确认替换整个学习库", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "备份与恢复", exact: true }),
  ).toBeVisible();
  await stale
    .getByRole("dialog")
    .getByRole("button", { name: "保存修改", exact: true })
    .click();
  await expect(stale.getByRole("dialog").getByRole("alert")).toContainText(
    "学习库已替换",
  );
  await stale.close();
  await expect(
    page.getByRole("button", { name: "下载快照", exact: true }).first(),
  ).toBeVisible();
  const snapshotEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载快照", exact: true })
    .first()
    .click();
  const snapshot = await snapshotEvent;
  const snap = JSON.parse(await readFile((await snapshot.path())!, "utf8"));
  expect(
    snap.expressions.some(
      (e: { id: string; meaning: string }) =>
        e.id === eid && e.meaning === "持续保持动力",
    ),
  ).toBe(true);
  await page.goto(`/#expression/${eid}`);
  await expect(page.locator(".meaning")).toHaveText("持续保持动力");
  await expect(
    page
      .locator(".stats-row > div")
      .filter({ hasText: "Used" })
      .locator("strong"),
  ).toHaveText("1");
  await page.screenshot({
    path: testInfo.outputPath("maintained-detail.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
