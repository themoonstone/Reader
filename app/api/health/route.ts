import { runtimeConfig, requestOrigin } from "@/lib/runtime-config";
import { getStore } from "@/lib/store";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    requestOrigin(request, runtimeConfig());
    getStore().one("SELECT 1");
    return Response.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
