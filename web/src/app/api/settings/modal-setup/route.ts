import { NextResponse } from "next/server";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

/**
 * POST /api/settings/modal-setup
 * Runs `modal setup` and streams stdout/stderr as SSE events.
 * The modal CLI prints an authentication URL the user must visit.
 * Once authenticated, the process exits and tokens are saved to ~/.modal.toml.
 */
export async function POST() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // Spawn modal setup (no TTY — it will print the URL instead of opening a browser)
      const child = spawn("modal", ["setup"], {
        env: { ...process.env, BROWSER: "", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        output += line + "\n";

        // Extract URLs from the output
        const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
        if (urlMatch) {
          send({ type: "url", url: urlMatch[1], line });
        } else {
          send({ type: "output", line });
        }
      };

      let stdoutBuf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      child.on("close", (code) => {
        // Flush remaining buffer
        if (stdoutBuf.trim()) processLine(stdoutBuf);
        if (stderrBuf.trim()) processLine(stderrBuf);

        if (code === 0) {
          send({ type: "done", success: true, message: "Modal setup completed successfully." });
        } else {
          send({ type: "done", success: false, message: `Modal setup exited with code ${code}.` });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      });

      child.on("error", (err) => {
        send({
          type: "done",
          success: false,
          message: err.message.includes("ENOENT")
            ? "Modal CLI not found. Install it with: pip install modal"
            : `Failed to start modal setup: ${err.message}`,
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      });

      // Safety timeout: 5 minutes (modal setup waits for browser auth)
      const timeout = setTimeout(() => {
        child.kill();
        send({ type: "done", success: false, message: "Modal setup timed out after 5 minutes." });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }, 5 * 60 * 1000);

      child.on("close", () => clearTimeout(timeout));
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
