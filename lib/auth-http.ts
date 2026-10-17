import { z } from "zod";
import { authContext, isOwner, type AuthContext } from "./auth";
import {
  AccessError,
  runtimeConfig,
  requestOrigin,
  writeOrigin,
} from "./runtime-config";
async function jsonInput(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AccessError("请使用 JSON 请求", 415);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (reader)
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > 8192) {
        await reader.cancel();
        throw new AccessError("请求过大", 413);
      }
      chunks.push(r.value);
    }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AccessError("输入格式无效", 400);
  }
}
let inFlight = 0;
export async function handleAuth(request: Request, action: string) {
  let auth: AuthContext | undefined;
  const reply = (data: unknown, status = 200) => {
    const response = Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
    return auth ? auth.apply(response) : response;
  };
  try {
    const config = runtimeConfig(),
      origin = requestOrigin(request, config);
    if (config.mode === "local")
      return reply({ mode: "local" }, action === "session" ? 200 : 404);
    auth = authContext(request, config);
    const client = auth.client!;
    if (request.method === "GET" && action === "session") {
      const user = await auth.owner();
      return reply({ mode: "cloud", email: user!.email });
    }
    if (request.method !== "POST") throw new AccessError("接口不存在", 404);
    writeOrigin(request, origin);
    const body = await jsonInput(request);
    if (inFlight >= 8) throw new AccessError("认证请求较多，请稍后重试", 429);
    inFlight++;
    try {
      if (action === "login") {
        const b = z
          .object({
            email: z.email().max(254),
            password: z.string().min(1).max(1024),
          })
          .strict()
          .parse(body);
        if (b.email.trim().toLowerCase() !== config.ownerEmail)
          throw new AccessError("邮箱或密码不正确", 401, "LOGIN_FAILED");
        const { data, error } = await client.auth.signInWithPassword(b);
        if (error) {
          if (!error.status || error.status >= 500)
            throw new AccessError("认证服务暂不可用", 503, "AUTH_UNAVAILABLE");
          throw new AccessError(
            "邮箱或密码不正确，或请求过于频繁",
            error.status === 429 ? 429 : 401,
            "LOGIN_FAILED",
          );
        }
        if (!isOwner(data.user, config)) {
          await client.auth.signOut({ scope: "local" });
          auth.clear();
          throw new AccessError("该账号无权访问此学习库", 403, "NOT_OWNER");
        }
        return reply({ ok: true });
      }
      if (action === "forgot") {
        const b = z
          .object({ email: z.email().max(254) })
          .strict()
          .parse(body);
        if (b.email.trim().toLowerCase() === config.ownerEmail) {
          const { error } = await client.auth.resetPasswordForEmail(b.email, {
            redirectTo: `${origin}/reset-password`,
          });
          if (error) console.error("READWORDS_RECOVERY_PROVIDER_FAILED");
        }
        return reply({
          ok: true,
          message: "若该邮箱可用于此学习库，将收到密码重置邮件。",
        });
      }
      if (action === "logout") {
        await auth.owner();
        const { error } = await client.auth.signOut({ scope: "global" });
        if (error)
          throw new AccessError(
            "退出未完成，请稍后重试",
            503,
            "AUTH_UNAVAILABLE",
          );
        auth.clear();
        return reply({ ok: true });
      }
      if (action === "password") {
        await auth.owner();
        const b = z
          .object({ password: z.string().min(12).max(128) })
          .strict()
          .parse(body);
        const { error } = await client.auth.updateUser({
          password: b.password,
        });
        if (error)
          throw new AccessError(
            "密码修改失败，请检查密码策略或重新申请恢复邮件",
            400,
            "PASSWORD_FAILED",
          );
        const { error: logoutError } = await client.auth.signOut({
          scope: "global",
        });
        if (logoutError)
          throw new AccessError(
            "密码已修改，但会话撤销未完成；请在认证后台撤销会话",
            503,
            "AUTH_UNAVAILABLE",
          );
        auth.clear();
        return reply({ ok: true });
      }
      throw new AccessError("接口不存在", 404);
    } finally {
      inFlight--;
    }
  } catch (error) {
    if (error instanceof AccessError)
      return reply({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return reply(
        {
          error: "请检查邮箱和密码格式；新密码需 12–128 字符",
          code: "INVALID_INPUT",
        },
        400,
      );
    return reply(
      { error: "认证服务暂不可用，请稍后重试", code: "AUTH_UNAVAILABLE" },
      503,
    );
  }
}
export async function confirmRecovery(request: Request) {
  let auth: AuthContext | undefined;
  try {
    const config = runtimeConfig(),
      origin = requestOrigin(request, config);
    if (config.mode !== "cloud") throw Error();
    auth = authContext(request, config);
    const url = new URL(request.url),
      token = url.searchParams.get("token_hash");
    if (
      url.searchParams.get("type") !== "recovery" ||
      !token ||
      token.length > 2048
    )
      throw Error();
    const { data, error } = await auth.client!.auth.verifyOtp({
      token_hash: token,
      type: "recovery",
    });
    if (error || !isOwner(data.user, config)) {
      auth.clear();
      throw Error();
    }
    return auth.apply(
      new Response(null, {
        status: 303,
        headers: {
          Location: `${origin}/reset-password`,
          "Referrer-Policy": "no-referrer",
        },
      }),
    );
  } catch {
    const r = new Response("恢复链接无效或已失效，请返回登录页重新申请。", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
    return auth ? auth.apply(r) : r;
  }
}
