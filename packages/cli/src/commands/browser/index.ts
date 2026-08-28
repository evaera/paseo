import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption } from "../../utils/command-options.js";
import {
  requireBrowserWorkspaceId,
  resolveBrowserWorkspaceId,
  validateExternalBrowserOpen,
  validateServiceUrl,
} from "./open-options.js";

interface BrowserOptions {
  host?: string;
  json?: boolean;
}

const execFileAsync = promisify(execFile);

async function openExternalBrowser(url: string): Promise<{ external: true; url: string }> {
  const command = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const env: NodeJS.ProcessEnv = { ...process.env, PASEO_BROWSER_OPEN_EXTERNAL: "1" };
  delete env.BROWSER;
  await execFileAsync(command, [url], { env });
  return { external: true, url };
}

async function execute(
  options: BrowserOptions,
  command: BrowserAutomationCommand,
  requestOptions?: { workspaceId?: string; timeoutMs?: number },
) {
  const client = await connectToDaemon({ host: options.host });
  try {
    const features = client.getLastServerInfoMessage()?.features;
    if (features?.browserCommandRpc !== true) {
      throw new Error("Browser commands require an updated Paseo daemon.");
    }
    if (command.command === "open_service_url" && features.serviceUrlOpenPolicyRpc !== true) {
      throw new Error("Service URL policy routing requires an updated Paseo daemon.");
    }
    const payload = await client.executeBrowserCommand(command, requestOptions);
    if (!payload.ok) throw new Error(payload.error.message);
    return payload.result;
  } finally {
    await client.close().catch(() => {});
  }
}

function print(value: unknown, json?: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Control Paseo browser tabs");

  addDaemonHostOption(
    browser
      .command("open-service-url")
      .description("Open a service URL using the desktop Service URLs setting")
      .argument("<url>")
      .option("--workspace <workspaceId>", "Workspace ID (defaults to PASEO_WORKSPACE_ID)")
      .option("--wait", "Wait for the user's policy choice and final open result")
      .option("--json", "Output JSON"),
  ).action(async (url: string, options: BrowserOptions & { workspace?: string; wait?: boolean }) =>
    print(
      await execute(
        options,
        {
          command: "open_service_url",
          args: { url: validateServiceUrl(url), waitForResult: options.wait === true },
        },
        {
          workspaceId: requireBrowserWorkspaceId(options.workspace),
          ...(options.wait ? { timeoutMs: 5 * 60_000 + 5_000 } : {}),
        },
      ),
      options.json,
    ),
  );

  addDaemonHostOption(
    browser
      .command("open")
      .description("Open a browser tab")
      .argument("[url]")
      .option("--workspace <workspaceId>", "Workspace ID (defaults to PASEO_WORKSPACE_ID)")
      .option("--external", "Open in the system browser")
      .option("--json", "Output JSON"),
  ).action(
    async (
      url: string | undefined,
      options: BrowserOptions & { external?: boolean; workspace?: string },
    ) =>
      print(
        options.external
          ? await openExternalBrowser(validateExternalBrowserOpen(url, options))
          : await execute(
              options,
              { command: "new_tab", args: url ? { url } : {} },
              { workspaceId: resolveBrowserWorkspaceId(options.workspace) },
            ),
        options.json,
      ),
  );
  return browser;
}
