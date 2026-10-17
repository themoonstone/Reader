import { z } from "zod";
export type RuntimeConfig = {
  mode: "local" | "cloud";
  origin?: string;
  authUrl?: string;
  authKey?: string;
  ownerId?: string;
  ownerEmail?: string;
  secure: boolean;
};
export class AccessError extends Error {
  constructor(
    message: string,
    public status = 403,
    public code = "ACCESS_DENIED",
  ) {
    super(message);
  }
}
export function runtimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const mode = env.READWORDS_MODE ?? "local";
  if (mode === "local") return { mode, secure: false };
  if (mode !== "cloud")
    throw new AccessError("运行模式无效，服务未启用", 503, "CONFIG_ERROR");
  try {
    const origin = new URL(env.READWORDS_ORIGIN ?? "");
    const auth = new URL(env.SUPABASE_URL ?? "");
    const loopback = (u: URL) =>
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    for (const u of [origin, auth])
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        u.pathname !== "/" ||
        (u.protocol !== "https:" &&
          !(
            env.NODE_ENV !== "production" &&
            u.protocol === "http:" &&
            loopback(u)
          ))
      )
        throw Error();
    if (
      !env.SUPABASE_PUBLISHABLE_KEY ||
      env.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_secret_")
    )
      throw Error();
    if (env.SUPABASE_PUBLISHABLE_KEY.startsWith("eyJ")) {
      const payload = JSON.parse(
        Buffer.from(
          env.SUPABASE_PUBLISHABLE_KEY.split(".")[1] || "",
          "base64url",
        ).toString(),
      );
      if (payload.role !== "anon") throw Error();
    } else if (!env.SUPABASE_PUBLISHABLE_KEY.startsWith("sb_publishable_"))
      throw Error();
    const ownerId = z.uuid().parse(env.READWORDS_OWNER_ID),
      ownerEmail = z
        .email()
        .parse(env.READWORDS_OWNER_EMAIL)
        .trim()
        .toLowerCase();
    return {
      mode,
      origin: origin.origin,
      authUrl: auth.origin,
      authKey: env.SUPABASE_PUBLISHABLE_KEY,
      ownerId,
      ownerEmail,
      secure: origin.protocol === "https:",
    };
  } catch {
    throw new AccessError(
      "云端配置缺失或无效，请检查服务端环境变量",
      503,
      "CONFIG_ERROR",
    );
  }
}
export function requestOrigin(
  request: Request,
  config: RuntimeConfig = runtimeConfig(),
) {
  const url = new URL(request.url),
    host = request.headers.get("host") || url.host;
  if (config.mode === "local") {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(host)
    )
      throw new AccessError("仅允许本机访问");
    return new URL(`${url.protocol}//${host}`).origin;
  }
  if (host !== new URL(config.origin!).host)
    throw new AccessError("请求 Host 不在允许列表");
  return config.origin!; // never trust arbitrary forwarded headers
}
export function writeOrigin(request: Request, origin: string) {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AccessError("拒绝跨站写入请求");
}
