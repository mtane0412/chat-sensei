import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "chat-sensei",
  description:
    "Read Twitch live chat in three columns — raw chat, translation, and Pick up — powered entirely by Chrome's built-in AI (Gemini Nano). Runs fully client-side.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* 接続中の画面(embed + 3カラム)をビューポート1ページに収めるため、高さを固定して内部スクロールに任せる */}
      <body className="flex h-dvh flex-col overflow-hidden">
        <SiteHeader />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
