import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption } from "../../utils/command-options.js";
import { resolveBrowserWorkspaceId, validateExternalBrowserOpen } from "./open-options.js";

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

function print(value: unknown, json?: boolean): void {
  process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Control Paseo browser tabs");

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
        await (async () => {
          if (options.external) {
            return await openExternalBrowser(validateExternalBrowserOpen(url, options));
          }
          const client = await connectToDaemon({ host: options.host });
          try {
            if (client.getLastServerInfoMessage()?.features?.browserCommandRpc !== true) {
              throw new Error("Browser commands require an updated Paseo daemon.");
            }
            const payload = await client.executeBrowserCommand(
              { command: "new_tab", args: { ...(url ? { url } : {}) } },
              { workspaceId: resolveBrowserWorkspaceId(options.workspace) },
            );
            if (!payload.ok) throw new Error(payload.error.message);
            return payload.result;
          } finally {
            await client.close().catch(() => {});
          }
        })(),
        options.json,
      ),
  );
  return browser;
}
