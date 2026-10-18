import { test, expect } from "@playwright/test";
test("Signed-in mobile workspace keeps account, navigation and dialogs usable without horizontal overflow", async ({
  page,
}, testInfo) => {
  const longEmail =
    "a-long-personal-reading-account-for-mobile-layout@example.test";
  await page.route("**/api/auth/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, email: longEmail } });
  });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill("owner@example.test");
  await page.getByLabel("密码", { exact: true }).fill("cloud-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const logout = page.getByRole("button", { name: "退出登录", exact: true });
  await expect(logout).toBeVisible();
  await expect(page.locator(".account-email")).toHaveAttribute(
    "title",
    longEmail,
  );
  for (const width of [320, 393, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 852 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `No page overflow at ${width}px`,
    ).toBeTruthy();
    const sidebar = (await page.locator(".sidebar").boundingBox())!;
    const main = (await page.locator("main").boundingBox())!;
    if (width <= 850) {
      expect(main.x).toBe(0);
      expect(main.y).toBeGreaterThanOrEqual(sidebar.y + sidebar.height - 1);
      expect((await logout.boundingBox())!.height).toBeLessThan(56);
      expect(
        await logout.evaluate((el) => getComputedStyle(el).whiteSpace),
      ).toBe("nowrap");
      const nav = page.locator(".sidebar nav button");
      await expect(nav).toHaveCount(4);
      for (const button of await nav.all()) {
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    } else {
      expect(main.x).toBe(224);
      expect(sidebar.width).toBe(224);
    }
    if (width === 393 || width === 1280)
      await page.screenshot({
        path: testInfo.outputPath(`workspace-${width}.png`),
        fullPage: true,
      });
  }
  await page.setViewportSize({ width: 393, height: 852 });
  const nav = page.getByRole("navigation", { name: "主导航" });
  for (const [label, heading] of [
    ["Inbox", "Inbox"],
    ["Review", "近期想练"],
    ["Search", "Search"],
    ["Library", "每一种遇见"],
  ]) {
    await nav.getByRole("button", { name: new RegExp(label) }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      heading,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBeTruthy();
  }
  await page.getByRole("button", { name: /云端工作空间/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "云端工作空间",
  );
  await nav.getByRole("button", { name: /Library/ }).click();
  await page
    .getByRole("button", { name: "＋ 新建来源", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题 *", { exact: true }).fill("Mobile layout test");
  expect(
    await dialog
      .getByLabel("标题 *", { exact: true })
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(393);
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Mobile layout test", exact: true }),
  ).toBeVisible();
  await logout.click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/sources")).status()).toBe(401);
});
test("Private email login, API protection, refresh cookies, original source workflow, logout and password recovery", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/sources")).status()).toBe(401);
  expect((await page.request.get("/api/backup/status")).status()).toBe(401);
  await page.getByLabel("邮箱", { exact: true }).fill("owner@example.test");
  await page.getByLabel("密码", { exact: true }).fill("bad-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "邮箱或密码" }),
  ).toBeVisible();
  await page.getByLabel("密码", { exact: true }).fill("cloud-test-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  const cookies = await context.cookies();
  const auth = cookies.find((c) => c.name === "rw-auth")!;
  expect(auth.httpOnly).toBeTruthy();
  const session = JSON.parse(
    Buffer.from(auth.value.replace("base64-", ""), "base64url").toString(),
  );
  session.expires_at = 1;
  const parts = session.access_token.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  payload.exp = 1;
  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  session.access_token = parts.join(".");
  await context.addCookies([
    {
      ...auth,
      value:
        "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"),
    },
  ]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find((c) => c.name === "rw-auth")!.value,
  ).not.toBe(
    "base64-" + Buffer.from(JSON.stringify(session)).toString("base64url"),
  );
  await page
    .getByRole("button", { name: "＋ 新建来源", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("标题 *", { exact: true }).fill("Private cloud test");
  await dialog.getByRole("button", { name: "创建来源", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Private cloud test", exact: true }),
  ).toBeVisible();
  const generation = (
    await (await page.request.get("/api/backup/status")).json()
  ).generation;
  const large = await page.request.post("/api/backup/preview", {
    headers: {
      origin: "http://127.0.0.1:3104",
      "X-ReadWords-Generation": generation,
    },
    data: { padding: "x".repeat(11 * 1024 * 1024) },
  });
  expect(large.status()).toBe(400);
  expect((await large.json()).error).not.toBe("JSON 格式无效");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/sources")).status()).toBe(401);
  await page.getByRole("link", { name: "忘记密码" }).click();
  await page.getByLabel("邮箱", { exact: true }).fill("owner@example.test");
  await page.getByRole("button", { name: "发送重置邮件", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("若该邮箱");
  await page.goto(
    "/auth/confirm?token_hash=synthetic-recovery-proof&type=recovery",
  );
  await expect(page).toHaveURL(/\/reset-password$/);
  await page
    .getByLabel("新密码（12–128 字符）", { exact: true })
    .fill("changed-strong-password");
  await page
    .getByLabel("再次输入新密码", { exact: true })
    .fill("changed-strong-password");
  await page
    .getByRole("button", { name: "保存新密码并退出", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("邮箱", { exact: true }).fill("owner@example.test");
  await page
    .getByLabel("密码", { exact: true })
    .fill("changed-strong-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
  expect((await page.request.get("/api/sources")).status()).toBe(200);
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
