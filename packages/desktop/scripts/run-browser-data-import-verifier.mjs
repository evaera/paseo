import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const temporaryUserData = path.join(os.tmpdir(), `paseo-browser-import-verifier-${process.pid}`);
const verifier = path.join(import.meta.dirname, "verify-browser-data-import.mjs");
const child = spawn(electron, [verifier], {
  env: {
    ...process.env,
    PASEO_BROWSER_IMPORT_USER_DATA: temporaryUserData,
  },
  stdio: "inherit",
});
const timeout = setTimeout(() => {
  console.error("[browser-import] FAIL launcher timed out after 50000ms");
  child.kill("SIGKILL");
}, 50_000);

child.once("error", (error) => {
  clearTimeout(timeout);
  rmSync(temporaryUserData, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
  return undefined;
});
child.once("exit", (code, signal) => {
  clearTimeout(timeout);
  console.log("[browser-import] START temporary user data removal");
  rmSync(temporaryUserData, { recursive: true, force: true });
  console.log("[browser-import] PASS temporary user data removal");
  if (signal) {
    console.error(`[browser-import] FAIL Electron exited from ${signal}`);
    process.exitCode = 1;
    return undefined;
  }
  process.exitCode = code ?? 1;
  return undefined;
});
