// Isolated provider fixture only. Never imported by application code or included in Docker context.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
if (process.env.NODE_ENV === "production")
  throw Error("Test fixture cannot run in production");
const id = "f28c28b1-f77d-4e30-9a15-e151780e284b",
  email = "owner@example.test";
let password = "cloud-test-password",
  recoveryUsed = false;
const revoked = new Set<string>(),
  tokens = new Set<string>();
const user = () => ({
  id,
  email,
  email_confirmed_at: new Date().toISOString(),
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
});
const session = () => {
  const token = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        sub: id,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        session_id: randomUUID(),
        aud: "authenticated",
      }),
    ).toString("base64url"),
    "synthetic-e2e-signature",
  ].join(".");
  tokens.add(token);
  return {
    access_token: token,
    refresh_token: "synthetic-e2e-refresh",
    expires_in: 3600,
    token_type: "bearer",
    user: user(),
  };
};
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (raw.length > 10000) {
    res.writeHead(413).end();
    return;
  }
  const body = JSON.parse(raw || "{}"),
    url = new URL(req.url!, "http://127.0.0.1:3103");
  const send = (data: unknown, status = 200) => {
    res
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(data));
  };
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (url.pathname === "/auth/v1/token") {
    if (url.searchParams.get("grant_type") === "refresh_token") {
      send(session());
      return;
    }
    if (body.email !== email || body.password !== password) {
      send(
        { error_code: "invalid_credentials", msg: "Invalid credentials" },
        400,
      );
      return;
    }
    send(session());
    return;
  }
  if (url.pathname === "/auth/v1/user") {
    if (!tokens.has(token) || revoked.has(token)) {
      send({ message: "Invalid token" }, 401);
      return;
    }
    if (req.method === "PUT") password = body.password;
    send(user());
    return;
  }
  if (url.pathname === "/auth/v1/logout") {
    for (const token of tokens) revoked.add(token);
    send({});
    return;
  }
  if (url.pathname === "/auth/v1/recover") {
    send({});
    return;
  }
  if (url.pathname === "/auth/v1/verify") {
    if (body.token_hash !== "synthetic-recovery-proof" || recoveryUsed) {
      send({ message: "Expired" }, 400);
      return;
    }
    recoveryUsed = true;
    send(session());
    return;
  }
  send({ message: "Missing" }, 404);
});
await new Promise<void>((r) => server.listen(3103, "127.0.0.1", r));
const app = spawn("npm", ["run", "dev", "--", "--port", "3104"], {
  stdio: "inherit",
  env: {
    ...process.env,
    READWORDS_MODE: "cloud",
    READWORDS_ORIGIN: "http://127.0.0.1:3104",
    SUPABASE_URL: "http://127.0.0.1:3103",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
    READWORDS_OWNER_ID: id,
    READWORDS_OWNER_EMAIL: email,
    READWORDS_DB_PATH: join(
      tmpdir(),
      `readwords-cloud-e2e-${process.pid}.sqlite`,
    ),
    READWORDS_DIST_DIR: ".next-cloud-e2e",
    NEXT_TELEMETRY_DISABLED: "1",
  },
});
function stop() {
  app.kill("SIGTERM");
  server.close();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
app.on("exit", (code) => {
  server.close();
  process.exitCode = code ?? 0;
});
