"use client";
import { useEffect, useState } from "react";
export default function Account() {
  const [email, setEmail] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEmail(d.email || ""))
      .catch(() => {});
  }, []);
  if (!email) return null;
  return (
    <div className="account">
      <p className="account-email" title={email}>
        {email}
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const r = await fetch("/api/auth/logout", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
            if (!r.ok) throw Error((await r.json()).error);
            window.location.assign("/login");
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        退出登录
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
