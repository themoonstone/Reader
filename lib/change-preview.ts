import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError, type Store } from "./store";
const state = globalThis as unknown as { readwordsChangeSecret?: Buffer };
const secret = () => (state.readwordsChangeSecret ??= randomBytes(32));
const sign = (s: string) =>
  createHmac("sha256", secret()).update(s).digest("base64url");
export const hashValue = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function materialState(store: Store) {
  return hashValue([
    store.generation,
    ...["sources", "expressions", "contexts", "drafts"].map((t) =>
      store.all(`SELECT * FROM ${t} ORDER BY id`),
    ),
  ]);
}
export function sealChange(kind: string, payload: unknown) {
  const s = Buffer.from(
    JSON.stringify({ kind, payload, expires: Date.now() + 30 * 60_000 }),
  ).toString("base64url");
  return `${s}.${sign(s)}`;
}
export function openChange<T>(token: string, kind: string): T {
  const fail = () =>
    new AppError("对比已失效或内容已变化，请重新预览", 409, "PREVIEW_STALE");
  if (token.length > 8192) throw fail();
  const [s, signature, extra] = token.split(".");
  if (!s || !signature || extra) throw fail();
  const a = Buffer.from(signature),
    b = Buffer.from(sign(s));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail();
  try {
    const data = JSON.parse(Buffer.from(s, "base64url").toString());
    if (data.kind !== kind || data.expires < Date.now()) throw fail();
    return data.payload;
  } catch {
    throw fail();
  }
}
