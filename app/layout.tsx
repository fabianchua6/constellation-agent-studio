import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Constellation — your agent studio",
  description:
    "A multiplayer app studio where humans direct teams of AI agents to plan, build, review, and ship.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
