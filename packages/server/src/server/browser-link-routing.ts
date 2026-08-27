import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@getpaseo/cli/bin/paseo";
const BROWSER_OVERRIDE_ENV = "PASEO_BROWSER_OPEN_OVERRIDE";

interface BrowserOpenWrapperResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cliEntrypoint?: string | null;
}

function externalPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

function executableRealpath(filePath: string): string | null {
  try {
    const realPath = realpathSync(filePath);
    accessSync(realPath, constants.X_OK);
    return realPath;
  } catch {
    return null;
  }
}

function wrapperForCli(cliPath: string): string | null {
  const executableCli = executableRealpath(cliPath);
  if (!executableCli) {
    return null;
  }
  const cliDir = dirname(executableCli);
  for (const candidate of [join(cliDir, "..", "open-wrapper", "open"), join(cliDir, "open")]) {
    const wrapper = executableRealpath(candidate);
    if (wrapper) {
      return wrapper;
    }
  }
  return null;
}

export function resolveBrowserOpenWrapperPath(
  options: BrowserOpenWrapperResolutionOptions = {},
): string | null {
  if ((options.platform ?? process.platform) !== "darwin") {
    return null;
  }

  const configuredCli = (options.env ?? process.env).PASEO_CLI?.trim();
  if (configuredCli) {
    const wrapper = wrapperForCli(resolve(configuredCli));
    if (wrapper) {
      return wrapper;
    }
  }

  let cliEntrypoint = options.cliEntrypoint;
  if (cliEntrypoint === undefined) {
    try {
      cliEntrypoint = require.resolve(PASEO_CLI_BIN_ENTRY);
    } catch {
      cliEntrypoint = null;
    }
  }
  if (!cliEntrypoint) {
    return null;
  }

  const asarMarker = join("app.asar", "node_modules");
  const asarIndex = cliEntrypoint.indexOf(asarMarker);
  if (asarIndex >= 0) {
    const resourcesDir = cliEntrypoint.slice(0, asarIndex);
    return wrapperForCli(join(resourcesDir, "bin", "paseo"));
  }
  return wrapperForCli(externalPath(cliEntrypoint));
}

export function injectBrowserLinkRouting(
  env: Record<string, string>,
  workspaceId: string | undefined = env.PASEO_WORKSPACE_ID,
  wrapperPath: string | null = resolveBrowserOpenWrapperPath(),
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform !== "darwin" || !workspaceId?.trim() || !wrapperPath) {
    return env;
  }

  const executableWrapper = executableRealpath(wrapperPath);
  if (!executableWrapper) {
    return env;
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? process.env[pathKey] ?? "";
  const wrapperDir = dirname(executableWrapper);
  const entries = currentPath.split(delimiter).filter(Boolean);
  const nextPath = [wrapperDir, ...entries.filter((entry) => entry !== wrapperDir)].join(delimiter);
  const replaceBrowser = env[BROWSER_OVERRIDE_ENV] === "1" || !env.BROWSER?.trim();
  return {
    ...env,
    PASEO_WORKSPACE_ID: workspaceId,
    ...(replaceBrowser ? { BROWSER: executableWrapper } : {}),
    [pathKey]: nextPath,
  };
}
