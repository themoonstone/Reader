export class RequestError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new RequestError(
      "无法连接本机服务。请检查终端中的服务是否运行；当前输入仍保留。",
      "OFFLINE",
    );
  }
  const data = await response.json();
  if (!response.ok)
    throw new RequestError(
      data.error || "操作失败，请重试",
      data.code || "FAILED",
    );
  return data as T;
}
export const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const displayDate = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
