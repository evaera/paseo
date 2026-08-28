import http from "node:http";
import { app, BrowserWindow, session } from "electron";
import {
  injectLocalStorageWithInertOrigins,
  installSessionStorageRestore,
} from "../dist/features/browser-data-import-target.js";

const STAGE_TIMEOUT_MS = 10_000;
const HARNESS_TIMEOUT_MS = 45_000;
const temporaryUserData = process.env.PASEO_BROWSER_IMPORT_USER_DATA;
if (!temporaryUserData) throw new Error("PASEO_BROWSER_IMPORT_USER_DATA is required");

app.setPath("userData", temporaryUserData);
app.on("window-all-closed", () => undefined);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stage(name, operation, timeoutMs = STAGE_TIMEOUT_MS) {
  const startedAt = Date.now();
  console.log(`[browser-import] START ${name}`);
  let timeoutId;
  try {
    const value = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    console.log(`[browser-import] PASS ${name} (${Date.now() - startedAt}ms)`);
    return value;
  } catch (error) {
    console.error(`[browser-import] FAIL ${name} (${Date.now() - startedAt}ms)`, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function listen() {
  let requestCount = 0;
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/html",
      connection: "close",
    });
    response.end("<!doctype html><title>browser import verifier</title>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP verifier did not bind");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    getRequestCount: () => requestCount,
  };
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main() {
  await stage("Electron ready", () => app.whenReady());
  const { server, origin, getRequestCount } = await stage("HTTP server listen", listen);
  const partition = `persist:paseo-browser-import-verifier-${process.pid}`;
  const verifierSession = session.fromPartition(partition);
  const localWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      javascript: false,
      nodeIntegration: false,
    },
  });
  let localVerificationWindow = null;
  let sessionWindow = null;
  let freshWindow = null;
  try {
    const localRecord = { origin, key: "local-key", value: "local-value" };
    const localOutcome = await stage("inert localStorage CDP import", () =>
      injectLocalStorageWithInertOrigins(localWindow.webContents, [localRecord]),
    );
    assert(getRequestCount() === 0, "Origin bootstrap reached the HTTP server");
    assert(
      localOutcome.imported === 1 && localOutcome.skipped === 0,
      `Unexpected localStorage CDP outcome: ${JSON.stringify(localOutcome)}`,
    );
    localVerificationWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await stage("localStorage verification navigation", () =>
      localVerificationWindow.loadURL(`${origin}/local`),
    );
    const localValue = await stage("localStorage verification read", () =>
      localVerificationWindow.webContents.executeJavaScript("localStorage.getItem('local-key')"),
    );
    assert(localValue === "local-value", "CDP localStorage value did not round-trip");

    sessionWindow = new BrowserWindow({
      show: false,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const sessionRecord = { origin, key: "session-key", value: "session-value" };
    const sessionOutcome = await stage("sessionStorage restore", () =>
      installSessionStorageRestore(sessionWindow.webContents, [sessionRecord], `${origin}/session`),
    );
    assert(
      sessionOutcome.imported === 1 && sessionOutcome.unapplied.length === 0,
      `Unexpected sessionStorage outcome: ${JSON.stringify(sessionOutcome)}`,
    );
    const sessionValue = await stage("sessionStorage verification read", () =>
      sessionWindow.webContents.executeJavaScript("sessionStorage.getItem('session-key')"),
    );
    assert(sessionValue === "session-value", "sessionStorage was not applied before navigation");
    await stage("same-tab navigation", () => sessionWindow.loadURL(`${origin}/same-tab`));
    const retainedValue = await stage("same-tab sessionStorage read", () =>
      sessionWindow.webContents.executeJavaScript("sessionStorage.getItem('session-key')"),
    );
    assert(retainedValue === "session-value", "sessionStorage did not survive same-tab navigation");

    sessionWindow.destroy();
    sessionWindow = null;
    freshWindow = new BrowserWindow({
      show: false,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await stage("fresh-tab navigation", () => freshWindow.loadURL(`${origin}/fresh-tab`));
    const freshValue = await stage("fresh-tab sessionStorage read", () =>
      freshWindow.webContents.executeJavaScript("sessionStorage.getItem('session-key')"),
    );
    assert(freshValue === null, "sessionStorage leaked into a fresh tab lifecycle");

    console.log(
      "Electron browser data import verification passed: CDP localStorage round-trip and sessionStorage tab lifecycle",
    );
  } finally {
    localWindow.destroy();
    localVerificationWindow?.destroy();
    sessionWindow?.destroy();
    freshWindow?.destroy();
    verifierSession.closeAllConnections();
    await stage("HTTP server close", () => closeServer(server));
  }
}

const harnessTimeout = setTimeout(() => {
  console.error(`[browser-import] FAIL harness timed out after ${HARNESS_TIMEOUT_MS}ms`);
  process.exitCode = 1;
  app.exit(1);
}, HARNESS_TIMEOUT_MS);

main()
  .then(() => {
    clearTimeout(harnessTimeout);
    process.exitCode = 0;
    app.exit(0);
    return undefined;
  })
  .catch((error) => {
    clearTimeout(harnessTimeout);
    console.error(error);
    process.exitCode = 1;
    app.exit(1);
  });
