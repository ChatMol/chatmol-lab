/**
 * Ad-hoc sign the macOS app bundle after packing.
 *
 * We have no Developer ID, so the workflow sets CSC_IDENTITY_AUTO_DISCOVERY=false
 * and electron-builder skips signing entirely. That does not leave the bundle
 * unsigned — it leaves Electron's own linker-signed ad-hoc signature on it,
 * which seals Electron's original contents, not ours. Once our app, resources
 * and runtime are added, that signature no longer matches:
 *
 *   codesign --verify: code has no resources but signature indicates they must be present
 *
 * macOS reports an invalid signature as "ChatMol Lab is damaged and can't be
 * opened", and right-click -> Open does not help, because that only bypasses
 * the unidentified-developer check.
 *
 * Re-signing ad-hoc produces a valid signature over what we actually ship, with
 * the bundle's real identifier. The app is still not notarized, so first launch
 * still needs right-click -> Open — but that is a prompt the user can answer,
 * instead of a dead end.
 *
 * codesign --deep follows bundle structure only (Frameworks, Helpers), so the
 * bundled runtime under Resources is left byte-for-byte alone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTITLEMENTS = fileURLToPath(new URL("../build/entitlements.mac.plist", import.meta.url));

export default async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;

  // A real certificate means electron-builder signs properly; don't overwrite it.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", ENTITLEMENTS, app],
    { stdio: "inherit" },
  );
  // Fail the build rather than ship a bundle that opens as "damaged".
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });

  console.log(`  • ad-hoc signed and verified ${path.basename(app)}`);
}
