import type { BrowserAutomationCommand } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import { addDaemonHostOption } from "../../utils/command-options.js";

interface BrowserOptions {
  host?: string;
  json?: boolean;
}

async function execute(options: BrowserOptions, command: BrowserAutomationCommand) {
  const client = await connectToDaemon({ host: options.host });
  try {
    if (client.getLastServerInfoMessage()?.features?.browserDataImport !== true) {
      throw new Error("Browser data import requires an updated Paseo daemon.");
    }
    const payload = await client.executeBrowserCommand(command);
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
  const browser = new Command("browser").description("Control Paseo browser tabs and browser data");

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

  return browser;
}
