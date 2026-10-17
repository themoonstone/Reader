import { test, expect } from "@playwright/test";
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
