import {
  createServerClient,
  parseCookieHeader,
  serializeCookieHeader,
  type CookieOptions,
} from "@supabase/ssr";
import {
  AccessError,
  runtimeConfig,
  type RuntimeConfig,
} from "./runtime-config";
import type { User } from "@supabase/supabase-js";
export function isOwner(user: User | null, config: RuntimeConfig) {
  return Boolean(
    user &&
    user.id === config.ownerId &&
    user.email?.trim().toLowerCase() === config.ownerEmail &&
    user.email_confirmed_at,
  );
}
export function authContext(request: Request, config = runtimeConfig()) {
  const jar = new Map(
    parseCookieHeader(request.headers.get("cookie") || "").map((c) => [
      c.name,
      c.value,
    ]),
  );
  const changes = new Map<string, { value: string; options: CookieOptions }>();
  const base: CookieOptions = {
    httpOnly: true,
    secure: config.secure,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 86400,
  };
  const client =
    config.mode === "cloud"
      ? createServerClient(config.authUrl!, config.authKey!, {
          cookieOptions: { ...base, name: "rw-auth" },
          global: {
            fetch: (input, init) =>
              fetch(input, {
                ...init,
                signal: AbortSignal.timeout(10000),
                cache: "no-store",
              }),
          },
          cookies: {
            getAll: () => [...jar].map(([name, value]) => ({ name, value })),
            setAll: (items) => {
              for (const c of items) {
                jar.set(c.name, c.value);
                changes.set(c.name, {
                  value: c.value,
                  options: {
                    ...c.options,
                    ...base,
                    maxAge: c.options.maxAge ?? base.maxAge,
                  },
                });
              }
            },
          },
        })
      : null;
  return {
    config,
    client,
    async owner() {
      if (!client) return null;
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) {
        if (error && (!error.status || error.status >= 500))
          throw new AccessError(
            "认证服务暂不可用，请保留输入后重试",
            503,
            "AUTH_UNAVAILABLE",
          );
        throw new AccessError(
          "登录已失效，请先登录；未保存输入仍保留",
          401,
          "UNAUTHENTICATED",
        );
      }
      if (!isOwner(data.user, config))
        throw new AccessError("该账号无权访问此学习库", 403, "NOT_OWNER");
      return data.user;
    },
    clear() {
      for (const name of new Set([...jar.keys(), ...changes.keys()]))
        if (name.startsWith("rw-auth"))
          changes.set(name, { value: "", options: { ...base, maxAge: 0 } });
    },
    apply(response: Response) {
      if (config.mode === "local") return response;
      response.headers.set("Cache-Control", "private, no-store, max-age=0");
      response.headers.set("Pragma", "no-cache");
      response.headers.set("Expires", "0");
      response.headers.set("Vary", "Cookie");
      for (const [name, c] of changes)
        response.headers.append(
          "Set-Cookie",
          serializeCookieHeader(name, c.value, c.options),
        );
      return response;
    },
  };
}
export type AuthContext = ReturnType<typeof authContext>;
