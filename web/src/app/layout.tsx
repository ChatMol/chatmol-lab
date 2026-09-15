import type { Metadata } from "next";
import { SessionProvider } from "next-auth/react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChatMol Lab",
  description: "AI Research Assistant for Computational Biology & Protein Design",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <SessionProvider>{children}</SessionProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              function handleChunkError(msg) {
                if (msg && (msg.includes("ChunkLoadError") || msg.includes("Loading chunk"))) {
                  window.location.reload();
                }
              }
              window.addEventListener("error", function(e) {
                handleChunkError(e.message || String(e));
              });
              window.addEventListener("unhandledrejection", function(e) {
                handleChunkError(e.reason && (e.reason.message || String(e.reason)));
              });
            `,
          }}
        />
      </body>
    </html>
  );
}
