import { authContext, type AuthContext } from "./auth";
import {
  AccessError,
  runtimeConfig,
  requestOrigin,
  writeOrigin,
} from "./runtime-config";
import { Review } from "./review";
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
  let auth: AuthContext | undefined;
  const json = (data: unknown, init: ResponseInit) => {
    const r = Response.json(data, init);
    return auth ? auth.apply(r) : r;
  };
  try {
    const url = new URL(request.url),
      config = runtimeConfig();
    const origin = requestOrigin(request, config);
    auth = authContext(request, config);
    await auth.owner();
    if (!["GET", "HEAD"].includes(request.method)) {
      writeOrigin(request, origin);
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("请使用 JSON 请求", 415);
    }
    const db = store ?? getStore();
    headers["X-ReadWords-Generation"] = db.generation;
    const [resource, id, action, reviewAction] = segments;
    if (segments.length > (resource === "review" ? 4 : 3))
      throw new AppError("接口不存在", 404);
    if (request.method === "GET") {
      let data;
      if (resource === "review" && segments.length === 2) {
        const review = new Review(db);
        if (id === "pool") data = review.pool();
        else if (id === "session") data = review.current();
        else if (id === "candidates")
          data = review.candidates(
            url.searchParams.get("q") || "",
            Number(url.searchParams.get("page") || 1),
            url.searchParams.get("sourceId") || "",
          );
        else throw new AppError("接口不存在", 404);
      } else if (resource === "backup" && id === "status")
        data = {
          generation: db.generation,
          snapshots: snapshots(db),
          snapshotDir: db.snapshotDir,
          schemaVersion: 3,
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
      return json(data, { headers });
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
    if (
      db.isReadOnly &&
      !(resource === "backup" && ["export", "snapshot"].includes(id))
    )
      throw new AppError(
        "学习库处于维护只读状态，请稍后重试",
        503,
        "READ_ONLY",
      );
    const body = z.record(z.string(), z.unknown()).parse(parsed);
    if (request.headers.get("X-ReadWords-Generation") !== db.generation)
      throw new AppError(
        "学习库已替换或页面版本过旧。请复制输入并刷新页面后重试。",
        409,
        "WORKSPACE_CHANGED",
      );
    let data;
    if (resource === "review") {
      const review = new Review(db),
        post = request.method === "POST";
      if (id === "pool" && post && !action) data = review.add(body);
      else if (
        id === "pool" &&
        action &&
        segments.length === 3 &&
        request.method === "PATCH"
      )
        data = review.updatePool(z.uuid().parse(action), body);
      else if (id === "sessions" && post && !action) data = review.start(body);
      else if (id === "sessions" && post && action && reviewAction) {
        const sid = z.uuid().parse(action);
        if (reviewAction === "lease") data = review.claim(sid, body);
        else if (reviewAction === "heartbeat")
          data = review.heartbeat(sid, body);
        else if (reviewAction === "next") data = review.next(sid, body);
        else if (reviewAction === "state") data = review.state(sid, body);
        else throw new AppError("接口不存在", 404);
      } else if (id === "cards" && post && action && reviewAction) {
        const cid = z.uuid().parse(action);
        if (reviewAction === "reveal") data = review.reveal(cid, body);
        else if (reviewAction === "feedback") data = review.feedback(cid, body);
        else if (reviewAction === "skip") data = review.skip(cid, body);
        else throw new AppError("接口不存在", 404);
      } else throw new AppError("接口不存在", 404);
    } else if (resource === "backup" && request.method === "POST") {
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
    return json(data, { headers });
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
          code: "INVALID_INPUT",
        },
        { status: 400, headers },
      );
    if (error instanceof AppError || error instanceof AccessError)
      return json(
        { error: error.message, code: error.code },
        { status: error.status, headers },
      );
    // Do not log user material or the SQLite exception's potentially sensitive SQL.
    console.error("READWORDS_STORAGE_ERROR");
    return json(
      {
        error: "本地存储操作失败，请保留输入后重试，并检查磁盘空间。",
        code: "STORAGE_ERROR",
      },
      { status: 500, headers },
    );
  }
}
