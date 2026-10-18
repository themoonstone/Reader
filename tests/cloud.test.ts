import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../lib/store";
import { Review } from "../lib/review";
import { emptyDraft } from "../lib/contracts";
import { exportBackup, previewRestore } from "../lib/backup";
import { handle } from "../lib/http";
import { handleAuth, confirmRecovery } from "../lib/auth-http";
import { runtimeConfig, requestOrigin } from "../lib/runtime-config";
import {
  maintenance,
  manifest,
  consistentBackup,
  compareManifests,
} from "../lib/operations";
const ownerId = "f28c28b1-f77d-4e30-9a15-e151780e284b",
  email = "owner@example.test";
const cloud = {
  READWORDS_MODE: "cloud",
  READWORDS_ORIGIN: "https://readwords.test",
  SUPABASE_URL: "https://auth.example.test",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READWORDS_OWNER_ID: ownerId,
  READWORDS_OWNER_EMAIL: email,
};
function env() {
  const before = { ...process.env };
  Object.assign(process.env, cloud);
  return () => {
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  };
}
function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  origin = "https://readwords.test",
) {
  return new Request(`https://readwords.test/${path}`, {
    method,
    headers: {
      host: "readwords.test",
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function cookie(r: Response) {
  return r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}
function provider() {
  const original = globalThis.fetch;
  let unavailable = false,
    revoked = false,
    verified = false,
    other = false,
    refreshes = 0;
  const consumed = new Set<string>();
  const user = () => ({
    id: other ? randomUUID() : ownerId,
    email,
    email_confirmed_at: verified ? null : new Date().toISOString(),
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  });
  const session = () => ({
    access_token: [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({
          sub: ownerId,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iat: Math.floor(Date.now() / 1000),
          aud: "authenticated",
          session_id: randomUUID(),
        }),
      ).toString("base64url"),
      "synthetic-test-signature",
    ].join("."),
    refresh_token: "synthetic-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: user(),
  });
  globalThis.fetch = async (input, init) => {
    if (unavailable)
      return Response.json({ message: "unavailable" }, { status: 503 });
    const url = new URL(String(input)),
      body = JSON.parse(String(init?.body || "{}"));
    if (url.pathname.endsWith("/token")) {
      if (url.searchParams.get("grant_type") === "refresh_token") refreshes++;
      if (body.password && body.password !== "test-password")
        return Response.json(
          { error_code: "invalid_credentials", msg: "Invalid credentials" },
          { status: 400 },
        );
      return Response.json(session());
    }
    if (url.pathname.endsWith("/user"))
      return revoked
        ? Response.json({ message: "revoked" }, { status: 401 })
        : Response.json(user());
    if (url.pathname.endsWith("/verify")) {
      if (body.token_hash !== "valid-recovery" || consumed.has(body.token_hash))
        return Response.json({ message: "expired" }, { status: 400 });
      consumed.add(body.token_hash);
      return Response.json(session());
    }
    if (url.pathname.endsWith("/logout")) {
      revoked = true;
      return Response.json({});
    }
    if (url.pathname.endsWith("/recover")) return Response.json({});
    throw Error("Unexpected provider path");
  };
  return {
    close: () => {
      globalThis.fetch = original;
    },
    down: (v: boolean) => (unavailable = v),
    revoke: () => (revoked = true),
    other: () => (other = true),
    unverified: () => (verified = true),
    get refreshes() {
      return refreshes;
    },
  };
}
test("Cloud mode requires complete valid config; localhost remains default; forwarded headers never change allowed origin", () => {
  assert.equal(runtimeConfig({}).mode, "local");
  assert.throws(() => runtimeConfig({ READWORDS_MODE: "unknown" }));
  assert.throws(() => runtimeConfig({ READWORDS_MODE: "cloud" }));
  assert.throws(() =>
    runtimeConfig({
      ...cloud,
      READWORDS_ORIGIN: "http://readwords.test",
      NODE_ENV: "production",
    }),
  );
  assert.throws(() =>
    runtimeConfig({ ...cloud, SUPABASE_PUBLISHABLE_KEY: "sb_secret_admin" }),
  );
  const req = request("api/sources");
  req.headers.set("x-forwarded-host", "evil.test");
  req.headers.set("x-forwarded-proto", "http");
  assert.equal(
    requestOrigin(req, runtimeConfig(cloud)),
    "https://readwords.test",
  );
  req.headers.set("host", "evil.test");
  assert.throws(() => requestOrigin(req, runtimeConfig(cloud)));
});
test("All business GET/POST/PATCH endpoints fail before SQLite access without a session, including backups and Review", async () => {
  const restore = env(),
    p = provider(),
    s = new Store(":memory:");
  try {
    for (const path of [
      "sources",
      "drafts",
      "expressions",
      "trash",
      "candidates",
      "backup/status",
      "review/pool",
      "review/session",
      "review/candidates",
    ])
      assert.equal(
        (await handle(request(`api/${path}`), path.split("/"), s)).status,
        401,
      );
    for (const method of ["POST", "PATCH"])
      for (const path of [
        "sources",
        "drafts",
        "expressions/" + randomUUID(),
        "imports/preview",
        "backup/export",
        "backup/preview",
        "backup/restore",
        "review/pool",
        "review/sessions",
      ])
        assert.equal(
          (await handle(request("api/" + path, method, {}), path.split("/"), s))
            .status,
          401,
        );
    assert.equal(s.sources().length, 0);
  } finally {
    s.close();
    p.close();
    restore();
  }
});
test("Email password login returns HttpOnly Secure cookies, owner can read, wrong user and unverified identity cannot", async () => {
  const restore = env(),
    p = provider(),
    s = new Store(":memory:");
  try {
    const failed = await handleAuth(
      request("api/auth/login", "POST", { email, password: "wrong" }),
      "login",
    );
    assert.equal(failed.status, 401);
    assert.equal((await failed.text()).includes("wrong"), false);
    const r = await handleAuth(
      request("api/auth/login", "POST", { email, password: "test-password" }),
      "login",
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(r.headers.get("set-cookie")!, /Secure/i);
    assert.match(r.headers.get("set-cookie")!, /SameSite=Lax/i);
    assert.match(r.headers.get("cache-control")!, /no-store/);
    const authCookie = cookie(r);
    assert.ok(authCookie);
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, authCookie),
          ["sources"],
          s,
        )
      ).status,
      200,
    );
    p.unverified();
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, authCookie),
          ["sources"],
          s,
        )
      ).status,
      403,
    );
  } finally {
    s.close();
    p.close();
    restore();
  }
});
test("UUID allowlist, revoked sessions, malformed cookies and service failure fail closed; auth writes reject cross-site and oversized data", async () => {
  const restore = env(),
    p = provider(),
    s = new Store(":memory:");
  try {
    const r = await handleAuth(
        request("api/auth/login", "POST", { email, password: "test-password" }),
        "login",
      ),
      c = cookie(r);
    assert.equal(
      (
        await handleAuth(
          request(
            "api/auth/login",
            "POST",
            { email, password: "test-password" },
            "",
            "https://evil.test",
          ),
          "login",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleAuth(
          request("api/auth/login", "POST", {
            email,
            password: "x".repeat(9000),
          }),
          "login",
        )
      ).status,
      413,
    );
    p.other();
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, c),
          ["sources"],
          s,
        )
      ).status,
      403,
    );
    p.revoke();
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, c),
          ["sources"],
          s,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, "rw-auth=forged"),
          ["sources"],
          s,
        )
      ).status,
      401,
    );
    p.down(true);
    assert.equal(
      (
        await handle(
          request("api/sources", "GET", undefined, c),
          ["sources"],
          s,
        )
      ).status,
      503,
    );
  } finally {
    s.close();
    p.close();
    restore();
  }
});
test("Password recovery consumes provider proof, enforces owner and password policy, signs out; replayed link cannot recover", async () => {
  const restore = env(),
    p = provider();
  try {
    for (const address of [email, "unknown@example.test"]) {
      const r = await handleAuth(
        request("api/auth/forgot", "POST", { email: address }),
        "forgot",
      );
      assert.equal(r.status, 200);
      assert.match((await r.json()).message, /若该邮箱/);
    }
    assert.equal(
      (
        await confirmRecovery(
          request("auth/confirm?token_hash=bad&type=recovery"),
        )
      ).status,
      400,
    );
    const recovered = await confirmRecovery(
      request("auth/confirm?token_hash=valid-recovery&type=recovery"),
    );
    assert.equal(recovered.status, 303);
    assert.equal(
      recovered.headers.get("location"),
      "https://readwords.test/reset-password",
    );
    const c = cookie(recovered);
    assert.equal(
      (
        await handleAuth(
          request("api/auth/password", "POST", { password: "short" }, c),
          "password",
        )
      ).status,
      400,
    );
    const updated = await handleAuth(
      request(
        "api/auth/password",
        "POST",
        { password: "new-strong-password" },
        c,
      ),
      "password",
    );
    assert.equal(updated.status, 200);
    assert.match(updated.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal(
      (
        await confirmRecovery(
          request("auth/confirm?token_hash=valid-recovery&type=recovery"),
        )
      ).status,
      400,
    );
  } finally {
    p.close();
    restore();
  }
});
test("Logout revokes and clears provider cookies and stale authorization no longer succeeds", async () => {
  const restore = env(),
    p = provider();
  try {
    const r = await handleAuth(
      request("api/auth/login", "POST", { email, password: "test-password" }),
      "login",
    );
    const c = cookie(r);
    const loggedOut = await handleAuth(
      request("api/auth/logout", "POST", {}, c),
      "logout",
    );
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal(
      (
        await handleAuth(
          request("api/auth/session", "GET", undefined, c),
          "session",
        )
      ).status,
      401,
    );
  } finally {
    p.close();
    restore();
  }
});
function data() {
  const dir = mkdtempSync(join(tmpdir(), "rw-cloud-")),
    file = join(dir, "learning.sqlite"),
    store = new Store(file);
  const source = store.createSource({
    id: randomUUID(),
    title: "Cloud migration",
    type: "Reading",
  });
  const d = store.createDraft(randomUUID(), {
      ...emptyDraft("Reading", source.id),
      term: "keep safe",
      sentence: "Keep the data safe.",
      meaning: "保管好",
      priority: "P1",
    }),
    id = store.saveDraft(d.id, { version: 1 }).expressionId!;
  const review = new Review(store);
  review.add({
    operation_id: randomUUID(),
    expression_ids: [id],
    expected_versions: { [id]: 0 },
  });
  const start = review.start({
    request_id: randomUUID(),
    owner_tab: randomUUID(),
    budget_seconds: 600,
    card_limit: 5,
    new_limit: 3,
  });
  return {
    dir,
    file,
    store,
    review,
    start,
    source,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("Maintenance atomically blocks all business transactions, import/restore/review writes but allows reads and export, preserving lease", async () => {
  const f = data();
  try {
    const leases = f.store.all("SELECT * FROM review_leases");
    maintenance(f.file, true);
    const before = exportBackup(f.store);
    assert.throws(() =>
      f.store.createSource({
        id: randomUUID(),
        type: "Manual",
        title: "blocked",
      }),
    );
    assert.throws(() => previewRestore(f.store, before));
    assert.throws(() =>
      f.review.add({
        operation_id: randomUUID(),
        expression_ids: [f.store.search()[0].id],
        expected_versions: {},
      }),
    );
    f.review.current();
    f.review.pool();
    assert.deepEqual(f.store.all("SELECT * FROM review_leases"), leases);
    const req = (path: string) =>
      handle(
        new Request("http://localhost:3000/api/" + path, {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
            "X-ReadWords-Generation": f.store.generation,
          },
          body: "{}",
        }),
        path.split("/"),
        f.store,
      );
    assert.equal((await req("imports/commit")).status, 503);
    assert.equal((await req("backup/restore")).status, 503);
    assert.equal((await req("backup/export")).status, 200);
    maintenance(f.file, false);
    f.store.createSource({
      id: randomUUID(),
      type: "Manual",
      title: "now writable",
    });
    assert.equal(f.store.sources().length, 2);
  } finally {
    f.cleanup();
  }
});
test("Native consistency backup and manifest preserve schema3, pending review and live runtime lease; restore/reopen is safe", async () => {
  const f = data();
  try {
    const leases = f.store.all("SELECT * FROM review_leases"),
      before = manifest(f.file);
    const copy = await consistentBackup(f.file, join(f.dir, "copies"));
    assert.equal(compareManifests(before, manifest(copy)), true);
    assert.deepEqual(f.store.all("SELECT * FROM review_leases"), leases);
    assert.equal(statSync(copy).mode & 0o777, 0o600);
    const reopened = new Store(copy);
    try {
      assert.equal(new Review(reopened).current().session!.state, "running"); // same process keeps lease; real restart is tested below
      reopened.db
        .prepare("UPDATE review_leases SET process_id='old-runtime'")
        .run();
    } finally {
      reopened.close();
    }
    const restarted = new Store(copy);
    try {
      assert.equal(new Review(restarted).current().session!.state, "paused");
      assert.equal(
        restarted.one("SELECT count(*) AS n FROM review_leases")!.n,
        0,
      );
    } finally {
      restarted.close();
    }
  } finally {
    f.cleanup();
  }
});
test("Manifest detects equal-count field edits, ignores operational maintenance/leases; failures do not publish partial backup", async () => {
  const f = data();
  try {
    const a = manifest(f.file);
    maintenance(f.file, true);
    assert.ok(compareManifests(a, manifest(f.file)));
    maintenance(f.file, false);
    const e = f.store.search()[0];
    f.store.updateExpression(e.id, { ...e, meaning: "edited" }, e.version);
    assert.equal(compareManifests(a, manifest(f.file)), false);
    const bad = join(f.dir, "bad.sqlite");
    writeFileSync(bad, "broken");
    const dir = join(f.dir, "failed");
    await assert.rejects(() => consistentBackup(bad, dir));
    assert.deepEqual(readdirSync(dir), []);
    assert.throws(() => manifest(bad));
    const unsupported = join(f.dir, "unknown.sqlite");
    const d = new DatabaseSync(unsupported);
    d.exec("PRAGMA user_version=99");
    d.close();
    assert.throws(() => manifest(unsupported));
  } finally {
    f.cleanup();
  }
});

test("Maintenance waits for an in-flight SQLite writer, then prevents later transactions", async () => {
  const f = data();
  try {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec("BEGIN IMMEDIATE;INSERT INTO workspace_meta VALUES('inflight-proof','committed');");parentPort.postMessage('locked');setTimeout(()=>{db.exec('COMMIT');db.close();parentPort.postMessage('done');},150);`,
      { eval: true, workerData: f.file },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
    });
    maintenance(f.file, true);
    assert.equal(
      f.store.one(
        "SELECT value FROM workspace_meta WHERE key='inflight-proof'",
      )!.value,
      "committed",
    );
    assert.throws(() => f.store.createDraft(randomUUID(), { term: "blocked" }));
    await worker.terminate();
  } finally {
    f.cleanup();
  }
});
test("Automated backup job reports remote failure without pruning; success records policy/check and health timestamp", () => {
  const f = data();
  try {
    const bin = join(f.dir, "bin"),
      out = join(f.dir, "backups"),
      log = join(f.dir, "calls.jsonl");
    mkdirSync(bin);
    mkdirSync(out);
    const executable = join(bin, "restic");
    writeFileSync(
      executable,
      "#!" +
        process.execPath +
        "\n" +
        `const fs=require('node:fs');fs.appendFileSync(process.env.RW_TEST_LOG,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.RW_TEST_FAIL==='1')process.exit(1);`,
    );
    chmodSync(executable, 0o700);
    const environment = {
      ...process.env,
      READWORDS_DB_PATH: f.file,
      READWORDS_BACKUP_DIR: out,
      RESTIC_REPOSITORY: "synthetic-encrypted-repository",
      RESTIC_PASSWORD_FILE: join(f.dir, "synthetic-secret-file"),
      RW_TEST_LOG: log,
      PATH: bin + ":" + process.env.PATH,
    };
    const failed = spawnSync(process.execPath, ["scripts/backup-job.mts"], {
      env: { ...environment, RW_TEST_FAIL: "1" },
      encoding: "utf8",
    });
    assert.equal(failed.status, 1);
    assert.equal(existsSync(join(out, ".last-success")), false);
    assert.equal(
      readdirSync(out).filter((n) => n.endsWith(".sqlite")).length,
      1,
    );
    assert.equal(existsSync(join(out, ".backup.lock")), false);
    const lease = f.store.all("SELECT * FROM review_leases");
    const success = spawnSync(process.execPath, ["scripts/backup-job.mts"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    assert.ok(existsSync(join(out, ".last-success")));
    assert.deepEqual(f.store.all("SELECT * FROM review_leases"), lease);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      calls.some(
        (args) =>
          args.includes("--keep-daily") &&
          args.includes("7") &&
          args.includes("--keep-weekly") &&
          args.includes("4") &&
          args.includes("--prune"),
      ),
    );
    assert.ok(calls.some((args) => args[0] === "check"));
    writeFileSync(log, "");
    const dns = spawnSync(process.execPath, ["scripts/backup-job.mts"], {
      env: { ...environment, READWORDS_RESTIC_S3_BUCKET_LOOKUP: "dns" },
      encoding: "utf8",
    });
    assert.equal(dns.status, 0, dns.stderr);
    const dnsCalls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(dnsCalls.length, 3);
    assert.deepEqual(
      dnsCalls.map((args) => args.slice(0, 2)),
      Array(3).fill(["-o", "s3.bucket-lookup=dns"]),
    );
    assert.deepEqual(
      dnsCalls.map((args) => args[2]),
      ["backup", "forget", "check"],
    );
    const invalid = spawnSync(process.execPath, ["scripts/backup-job.mts"], {
      env: { ...environment, READWORDS_RESTIC_S3_BUCKET_LOOKUP: "invalid" },
      encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
    const missing = spawnSync(process.execPath, ["scripts/backup-job.mts"], {
      env: { ...environment, RESTIC_REPOSITORY: "" },
      encoding: "utf8",
    });
    assert.equal(missing.status, 1);
  } finally {
    f.cleanup();
  }
});

test("Page login redirect uses configured public HTTPS origin behind a loopback reverse proxy", async () => {
  const restore = env(),
    p = provider();
  try {
    const response = await proxy(
      new NextRequest("http://localhost:3000/", {
        headers: { host: "readwords.test", "x-forwarded-host": "evil.test" },
      }),
    );
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "https://readwords.test/login",
    );
  } finally {
    p.close();
    restore();
  }
});

test("Environment read-only cannot be cleared by DB flag and blocks schema initialization/upgrade", () => {
  const f = data(),
    old = process.env.READWORDS_READ_ONLY;
  let reopened: Store | undefined;
  try {
    process.env.READWORDS_READ_ONLY = "1";
    maintenance(f.file, false);
    assert.throws(() => f.store.createDraft(randomUUID(), { term: "blocked" }));
    assert.doesNotThrow(() => exportBackup(f.store));
    assert.throws(() => new Store(join(f.dir, "new.sqlite")));
    reopened = new Store(f.file);
    assert.equal(reopened.isReadOnly, true);
    reopened.close();
    reopened = undefined;
    const oldFile = join(f.dir, "old.sqlite"),
      legacy = new DatabaseSync(oldFile);
    legacy.exec(
      "PRAGMA user_version=2;CREATE TABLE workspace_meta(key TEXT PRIMARY KEY,value TEXT);",
    );
    legacy.close();
    assert.throws(() => new Store(oldFile));
    const unchanged = new DatabaseSync(oldFile);
    assert.equal(
      unchanged.prepare("PRAGMA user_version").get()!.user_version,
      2,
    );
    unchanged.close();
  } finally {
    if (old === undefined) delete process.env.READWORDS_READ_ONLY;
    else process.env.READWORDS_READ_ONLY = old;
    reopened?.close();
    f.cleanup();
  }
});
