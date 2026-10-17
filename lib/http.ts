import { z } from "zod";
import { AppError, getStore, type Store } from "./store";
import {
  exportBackup,
  previewRestore,
  commitRestore,
  snapshots,
  readSnapshot,
  MAX_BACKUP,
} from "./backup";
import { previewExcel, commitExcel } from "./excel-import";

export async function handle(
  request: Request,
  segments: string[],
  store?: Store,
): Promise<Response> {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  try {
    const url = new URL(request.url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      throw new AppError("仅允许本机访问", 403);
    // Next.js may reconstruct request.url with localhost even when the browser
    // visited 127.0.0.1. Use the actual, strictly loopback-only Host, never X-Forwarded-Host.
    const host = request.headers.get("host") || url.host;
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(host))
      throw new AppError("仅允许本机 Host", 403);
    const origin = new URL(`${url.protocol}//${host}`).origin;
    if (!["GET", "HEAD"].includes(request.method)) {
      if (
        request.headers.get("origin") !== origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        throw new AppError("拒绝跨站写入请求", 403);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("请使用 JSON 请求", 415);
    }
    const db = store ?? getStore();
    headers["X-ReadWords-Generation"] = db.generation;
    const [resource, id, action] = segments;
    if (segments.length > 3) throw new AppError("接口不存在", 404);
    if (request.method === "GET") {
      let data;
      if (resource === "backup" && id === "status")
        data = {
          generation: db.generation,
          snapshots: snapshots(db),
          snapshotDir: db.snapshotDir,
          schemaVersion: 2,
        };
      else if (resource === "trash") data = db.trash();
      else if (resource === "sources" && !id) data = db.sources();
      else if (resource === "drafts") data = id ? db.getDraft(id) : db.drafts();
      else if (resource === "candidates")
        data = db.candidates(url.searchParams.get("term") || "");
      else if (resource === "expressions")
        data = id
          ? db.expression(id)
          : db.search(
              url.searchParams.get("q") || "",
              url.searchParams.get("type") || "",
              url.searchParams.get("priority") || "",
              url.searchParams.get("archived") === "1",
              url.searchParams.get("sourceId") || "",
            );
      else throw new AppError("接口不存在", 404);
      return Response.json(data, { headers });
    }
    const limit =
      resource === "backup" && id === "preview"
        ? MAX_BACKUP
        : resource === "imports"
          ? 8 * 1024 * 1024
          : 128 * 1024;
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          throw new AppError("请求过大", 413);
        }
        chunks.push(value);
      }
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("JSON 格式无效");
    }
    const body = z.record(z.string(), z.unknown()).parse(parsed);
    if (request.headers.get("X-ReadWords-Generation") !== db.generation)
      throw new AppError(
        "学习库已替换或页面版本过旧。请复制输入并刷新页面后重试。",
        409,
        "WORKSPACE_CHANGED",
      );
    let data;
    if (resource === "backup" && request.method === "POST") {
      if (id === "export") {
        data = exportBackup(db);
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_BACKUP)
          throw new AppError(
            "学习库超过当前 50 MB JSON 恢复限制。请保留数据库并联系维护者，勿依赖无法恢复的导出。",
            413,
          );
      } else if (id === "preview") data = previewRestore(db, body);
      else if (id === "restore")
        data = commitRestore(
          db,
          z.uuid().parse(body.token),
          z.literal(true).parse(body.confirmed),
        );
      else if (id === "snapshot")
        data = readSnapshot(db, z.string().parse(body.name));
      else throw new AppError("接口不存在", 404);
    } else if (resource === "expressions" && id && request.method === "PATCH")
      data = db.updateExpression(
        id,
        body.data,
        z.number().int().positive().parse(body.version),
        z.enum(["active", "archived"]).optional().parse(body.lifecycle),
      );
    else if (
      resource === "expressions" &&
      id &&
      request.method === "POST" &&
      action === "delete"
    )
      data = db.deleteExpression(
        id,
        z.number().int().positive().parse(body.version),
      );
    else if (
      resource === "expressions" &&
      id &&
      request.method === "POST" &&
      action === "restore"
    )
      data = db.restoreExpression(
        id,
        z.number().int().positive().parse(body.version),
      );
    else if (resource === "contexts" && id && request.method === "PATCH")
      data = db.updateContext(
        id,
        body.data,
        z.number().int().positive().parse(body.version),
        z.uuid().parse(body.expressionId),
        z.boolean().optional().parse(body.allowDuplicate),
      );
    else if (
      resource === "contexts" &&
      id &&
      request.method === "POST" &&
      ["delete", "restore"].includes(action)
    )
      data = db.setContextDeleted(
        id,
        z.number().int().positive().parse(body.version),
        action === "delete",
      );
    else if (
      resource === "imports" &&
      id === "preview" &&
      request.method === "POST"
    ) {
      const file = z
        .object({
          fileName: z.string().max(250),
          content: z
            .string()
            .max(7 * 1024 * 1024)
            .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .parse(body);
      data = await previewExcel(
        Buffer.from(file.content, "base64"),
        file.fileName,
        db,
      );
    } else if (
      resource === "imports" &&
      id === "commit" &&
      request.method === "POST"
    )
      data = commitExcel(db, body);
    else if (resource === "sources" && request.method === "POST" && !id)
      data = db.createSource(body);
    else if (resource === "sources" && request.method === "PATCH" && id)
      data = db.updateSource(
        id,
        body.data,
        z.number().int().positive().parse(body.version),
        z.enum(["active", "archived"]).optional().parse(body.lifecycle),
      );
    else if (resource === "drafts" && request.method === "POST" && !id)
      data = db.createDraft(z.uuid().parse(body.id), body.data);
    else if (resource === "drafts" && request.method === "PATCH" && id)
      data = db.updateDraft(
        id,
        body.data,
        z.number().int().positive().parse(body.version),
        z.enum(["pending", "ignored"]).optional().parse(body.state),
      );
    else if (
      resource === "drafts" &&
      request.method === "POST" &&
      id &&
      action === "save"
    )
      data = db.saveDraft(
        id,
        z
          .object({
            version: z.number().int(),
            expressionId: z.uuid().optional(),
            newSense: z.boolean().optional(),
            allowDuplicate: z.boolean().optional(),
          })
          .parse(body),
      );
    else throw new AppError("接口不存在", 404);
    return Response.json(data, { headers });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
          code: "INVALID_INPUT",
        },
        { status: 400, headers },
      );
    if (error instanceof AppError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers },
      );
    // Do not log user material or the SQLite exception's potentially sensitive SQL.
    console.error("READWORDS_STORAGE_ERROR");
    return Response.json(
      {
        error: "本地存储操作失败，请保留输入后重试，并检查磁盘空间。",
        code: "STORAGE_ERROR",
      },
      { status: 500, headers },
    );
  }
}
