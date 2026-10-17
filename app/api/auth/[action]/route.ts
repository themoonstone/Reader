import { handleAuth } from "@/lib/auth-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function route(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return handleAuth(request, (await context.params).action);
}
export { route as GET, route as POST };
