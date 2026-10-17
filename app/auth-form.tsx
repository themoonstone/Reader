"use client";
import { useState, useEffect } from "react";
export default function AuthForm({
  kind,
}: {
  kind: "login" | "forgot" | "password";
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  return (
    <main className="auth-shell">
      <h1>
        {kind === "login"
          ? "登录 ReadWords"
          : kind === "forgot"
            ? "找回密码"
            : "设置新密码"}
      </h1>
      <p>这是你的私有学习库，不提供公开注册。</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setError("");
          setNotice("");
          if (kind === "password" && password !== confirm) {
            setError("两次密码不一致");
            return;
          }
          setBusy(true);
          try {
            const response = await fetch(`/api/auth/${kind}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                kind === "forgot"
                  ? { email }
                  : kind === "password"
                    ? { password }
                    : { email, password },
              ),
            });
            const data = await response.json();
            if (!response.ok) throw Error(data.error || "认证失败");
            setPassword("");
            setConfirm("");
            if (kind === "forgot") setNotice(data.message);
            else window.location.assign(kind === "login" ? "/" : "/login");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {kind !== "password" && (
          <label className="field">
            邮箱
            <input
              type="email"
              autoComplete="username"
              maxLength={254}
              required
              disabled={!ready}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}
        {kind !== "forgot" && (
          <label className="field">
            {kind === "password" ? "新密码（12–128 字符）" : "密码"}
            <input
              type="password"
              autoComplete={
                kind === "password" ? "new-password" : "current-password"
              }
              minLength={kind === "password" ? 12 : 1}
              maxLength={kind === "password" ? 128 : 1024}
              required
              disabled={!ready}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {kind === "password" && (
          <label className="field">
            再次输入新密码
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              disabled={!ready}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <button disabled={busy || !ready}>
          {busy
            ? "处理中…"
            : kind === "login"
              ? "登录"
              : kind === "forgot"
                ? "发送重置邮件"
                : "保存新密码并退出"}
        </button>
      </form>
      {kind === "login" ? (
        <a href="/forgot-password">忘记密码</a>
      ) : (
        <a href="/login">返回登录</a>
      )}
    </main>
  );
}
