import { NextRequest, NextResponse } from "next/server";
import { authContext, type AuthContext } from "./lib/auth";
import {
  AccessError,
  runtimeConfig,
  requestOrigin,
} from "./lib/runtime-config";
export async function proxy(request: NextRequest) {
  let auth: AuthContext | undefined;
  try {
    const config = runtimeConfig();
    requestOrigin(request, config);
    if (config.mode === "local") return NextResponse.next();
    const path = request.nextUrl.pathname;
    // API handlers independently authorize before opening SQLite and own cookie refresh.
    if (
      path.startsWith("/api/") ||
      path === "/auth/confirm" ||
      ["/login", "/forgot-password"].includes(path)
    )
      return NextResponse.next();
    auth = authContext(request, config);
    await auth.owner();
    return auth.apply(NextResponse.next());
  } catch (error) {
    if (error instanceof AccessError && error.status === 401)
      return (
        auth?.apply(
          NextResponse.redirect(
            new URL("/login", auth?.config.origin || request.url),
          ),
        ) ??
        NextResponse.redirect(
          new URL("/login", auth?.config.origin || request.url),
        )
      );
    return new NextResponse(
      error instanceof AccessError ? error.message : "认证服务暂不可用",
      {
        status: error instanceof AccessError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
