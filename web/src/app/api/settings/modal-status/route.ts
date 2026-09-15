import { NextResponse } from "next/server";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const dynamic = "force-dynamic";

interface ModalStatus {
  installed: boolean;
  authenticated: boolean;
  version: string;
  tokenId: string;
}

/**
 * GET /api/settings/modal-status
 * Checks if Modal CLI is installed and if tokens are configured.
 */
export async function GET() {
  const status: ModalStatus = {
    installed: false,
    authenticated: false,
    version: "",
    tokenId: "",
  };

  // Check if modal CLI is installed
  try {
    const version = execSync("modal --version 2>&1", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    status.installed = true;
    status.version = version;
  } catch {
    return NextResponse.json(status);
  }

  // Check for token via env vars
  if (process.env.MODAL_TOKEN_ID) {
    status.authenticated = true;
    const id = process.env.MODAL_TOKEN_ID;
    status.tokenId = id.length > 8 ? id.slice(0, 4) + "..." + id.slice(-4) : "****";
    return NextResponse.json(status);
  }

  // Check ~/.modal.toml for saved tokens
  const home = process.env.HOME || "";
  const tomlPath = path.join(home, ".modal.toml");
  try {
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, "utf-8");
      if (content.includes("token_id")) {
        status.authenticated = true;
        const match = content.match(/token_id\s*=\s*"?([^"\s]+)"?/);
        if (match) {
          const id = match[1];
          status.tokenId = id.length > 8 ? id.slice(0, 4) + "..." + id.slice(-4) : "****";
        }
      }
    }
  } catch {}

  return NextResponse.json(status);
}
