import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { WorkspaceLayoutPosition } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption } from "../../utils/command-options.js";
import { parsePosition, placement } from "../layout/index.js";
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

interface BrowserOpenOptions extends BrowserOptions {
  external?: boolean;
  pane?: string;
  profile?: string;
  split?: WorkspaceLayoutPosition;
  targetPane?: string;
  workspace?: string;
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
    if (
      (command.command === "list_import_sources" || command.command === "import_browser_data") &&
      features.browserDataImport !== true
    ) {
      throw new Error("Browser data import requires an updated Paseo daemon.");
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
  if (json || typeof value !== "object" || value === null) {
    process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 0)}\n`);
    return;
  }
  if ("profiles" in value && Array.isArray(value.profiles)) {
    for (const profile of value.profiles as Array<{ id: string; name: string }>) {
      process.stdout.write(`${profile.name}\t${profile.id}\n`);
    }
    return;
  }
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function createBrowserCommand(): Command {
  const browser = new Command("browser").description("Control Paseo browser tabs and profiles");

  addDaemonHostOption(
    browser
      .command("profiles")
      .description("List browser profiles")
      .option("--json", "Output JSON"),
  ).action(async (options: BrowserOptions) =>
    print(await execute(options, { command: "list_profiles", args: {} }), options.json),
  );
  addDaemonHostOption(
    browser
      .command("create-profile")
      .description("Create an isolated browser profile")
      .argument("<name>")
      .option("--json", "Output JSON"),
  ).action(async (name: string, options: BrowserOptions) =>
    print(await execute(options, { command: "create_profile", args: { name } }), options.json),
  );
  addDaemonHostOption(
    browser
      .command("delete-profile")
      .description("Delete a named browser profile")
      .argument("<profile>")
      .option("--json", "Output JSON"),
  ).action(async (profile: string, options: BrowserOptions) =>
    print(await execute(options, { command: "delete_profile", args: { profile } }), options.json),
  );
  addDaemonHostOption(
    browser
      .command("import-sources")
      .description("List installed browser profiles available for import")
      .option("--json", "Output JSON"),
  ).action(async (options: BrowserOptions) =>
    print(await execute(options, { command: "list_import_sources", args: {} }), options.json),
  );
  addDaemonHostOption(
    browser
      .command("import")
      .description("Import allowlisted site state into the Default browser session")
      .requiredOption("--source-browser <id>", "Source browser ID from import-sources")
      .requiredOption("--source-profile <id>", "Source profile ID from import-sources")
      .requiredOption("--domains <domains>", "Comma-separated domain allowlist")
      .option(
        "--categories <categories>",
        "Comma-separated cookies,localStorage,sessionStorage",
        "cookies",
      )
      .option("--confirm-merge", "Confirm merging into existing Default browser data")
      .option("--json", "Output JSON"),
  ).action(
    async (
      options: BrowserOptions & {
        sourceBrowser: string;
        sourceProfile: string;
        domains: string;
        categories: string;
        confirmMerge?: boolean;
      },
    ) => {
      const categories = options.categories.split(",").map((value) => value.trim());
      const allowedCategories = new Set(["cookies", "localStorage", "sessionStorage"]);
      if (categories.some((category) => !allowedCategories.has(category))) {
        throw new Error("Categories must be cookies, localStorage, or sessionStorage.");
      }
      return print(
        await execute(options, {
          command: "import_browser_data",
          args: {
            sourceBrowserId: options.sourceBrowser,
            sourceProfileId: options.sourceProfile,
            domains: options.domains.split(",").map((value) => value.trim()),
            categories: categories as Array<"cookies" | "localStorage" | "sessionStorage">,
            confirmMerge: options.confirmMerge ?? false,
          },
        }),
        options.json,
      );
    },
  );

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
      .option("--profile <profile>", "Browser profile name or ID")
      .option("--workspace <workspaceId>", "Workspace ID (defaults to PASEO_WORKSPACE_ID)")
      .option("--pane <pane-id>", "Open in an existing pane")
      .option("--split <position>", "Create a left, right, top, or bottom split", parsePosition)
      .option("--target-pane <pane-id>", "Pane to split")
      .option("--external", "Open in the system browser")
      .option("--json", "Output JSON"),
  ).action(async (url: string | undefined, options: BrowserOpenOptions) => {
    if (options.external) {
      if (options.profile || options.pane || options.split || options.targetPane) {
        throw new Error("--external cannot be combined with profile or pane placement options");
      }
      return print(
        await openExternalBrowser(validateExternalBrowserOpen(url, options)),
        options.json,
      );
    }
    const targetPlacement = placement(options);
    return print(
      await execute(
        options,
        {
          command: "new_tab",
          args: {
            ...(url ? { url } : {}),
            ...(options.profile ? { profile: options.profile } : {}),
            ...(targetPlacement ? { placement: targetPlacement } : {}),
          },
        },
        { workspaceId: resolveBrowserWorkspaceId(options.workspace) },
      ),
      options.json,
    );
  });
  return browser;
}
