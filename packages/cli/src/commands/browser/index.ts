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
    if (client.getLastServerInfoMessage()?.features?.browserCommandRpc !== true) {
      throw new Error("Browser commands require an updated Paseo daemon.");
    }
    const payload = await client.executeBrowserCommand(command);
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
      .command("open")
      .description("Open a browser tab")
      .argument("[url]")
      .option("--profile <profile>", "Browser profile name or ID")
      .option("--workspace <workspaceId>", "Workspace ID")
      .option("--json", "Output JSON"),
  ).action(
    async (
      url: string | undefined,
      options: BrowserOptions & { profile?: string; workspace?: string },
    ) =>
      print(
        await (async () => {
          const client = await connectToDaemon({ host: options.host });
          try {
            if (client.getLastServerInfoMessage()?.features?.browserCommandRpc !== true) {
              throw new Error("Browser commands require an updated Paseo daemon.");
            }
            const payload = await client.executeBrowserCommand(
              {
                command: "new_tab",
                args: {
                  ...(url ? { url } : {}),
                  ...(options.profile ? { profile: options.profile } : {}),
                },
              },
              { workspaceId: options.workspace },
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
