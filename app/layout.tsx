import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "ReadWords · 个人表达库",
  description: "从真正读过、听过、写过的英语中，建立自己的表达库。",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
