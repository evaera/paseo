import { Command, InvalidArgumentError } from "commander";
import type {
  WorkspaceLayoutCommand,
  WorkspaceLayoutPlacement,
  WorkspaceLayoutPosition,
} from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import { WorkspaceLayoutPositionSchema } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import { withOutput, type OutputSchema, type SingleResult } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";

const OPEN_KINDS = [
  "terminal",
  "agent",
  "file",
  "files",
  "changes_tree",
  "pull_request",
  "working_diff",
  "new_tab",
] as const;
type OpenKind = (typeof OPEN_KINDS)[number];

interface LayoutOptions {
  host?: string;
  cwd?: string;
  workspace?: string;
  hostInstance?: string;
  pane?: string;
  targetPane?: string;
  split?: WorkspaceLayoutPosition;
}
type LayoutResult = Record<string, unknown>;
const resultSchema: OutputSchema<LayoutResult> = {
  idField: "command",
  columns: [
    { header: "COMMAND", field: "command" },
    { header: "TAB", field: "tabId" },
    { header: "PANE", field: "paneId" },
  ],
};

export function createLayoutCommand(): Command {
  const layout = new Command("layout").description("Inspect and manage workspace pane layouts");
  addCommon(layout.command("inspect").description("Inspect pane and tab IDs")).action(
    withOutput<LayoutResult, []>((options, _command) =>
      run(options, { command: "get_layout", args: {} }),
    ),
  );

  addCommon(
    layout
      .command("open")
      .description("Open a non-browser workspace tab")
      .argument("<kind>", OPEN_KINDS.join(", "), parseOpenKind)
      .argument("[id]", "Target ID or file path")
      .option("--pane <pane-id>", "Open in an existing pane")
      .option("--split <position>", "Create a left, right, top, or bottom split", parsePosition)
      .option("--target-pane <pane-id>", "Pane to split"),
  ).action(
    withOutput<LayoutResult, [OpenKind, string | undefined]>((kind, id, options, _command) => {
      const targetPlacement = placement(options);
      return run(options, {
        command: "open_tab",
        args: {
          target: openTarget(kind, id),
          ...(targetPlacement ? { placement: targetPlacement } : {}),
        },
      });
    }),
  );

  addCommon(
    layout
      .command("split")
      .description("Create an empty split pane")
      .argument("<target-pane-id>")
      .argument("<position>", "left, right, top, or bottom", parsePosition),
  ).action(
    withOutput<LayoutResult, [string, WorkspaceLayoutPosition]>(
      (targetPaneId, position, options, _command) =>
        run(options, { command: "split_pane", args: { targetPaneId, position } }),
    ),
  );
  addCommon(
    layout
      .command("move-tab")
      .description("Move a tab to a pane")
      .argument("<tab-id>")
      .argument("<pane-id>"),
  ).action(
    withOutput<LayoutResult, [string, string]>((tabId, paneId, options, _command) =>
      run(options, { command: "move_tab", args: { tabId, paneId } }),
    ),
  );
  addCommon(
    layout
      .command("move-pane")
      .description("Move a pane beside another pane")
      .argument("<pane-id>")
      .argument("<target-pane-id>")
      .argument("<position>", "left, right, top, or bottom", parsePosition),
  ).action(
    withOutput<LayoutResult, [string, string, WorkspaceLayoutPosition]>(
      (paneId, targetPaneId, position, options, _command) =>
        run(options, { command: "move_pane", args: { paneId, targetPaneId, position } }),
    ),
  );
  return layout;
}

function addCommon(command: Command): Command {
  return addJsonAndDaemonHostOptions(
    command
      .option("--workspace <id>", "Workspace ID")
      .option("--cwd <path>", "Resolve workspace from directory")
      .option("--host-instance <id>", "Connected layout host instance ID"),
  );
}

async function run(
  options: LayoutOptions,
  command: WorkspaceLayoutCommand,
): Promise<SingleResult<LayoutResult>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const workspaceId =
      options.workspace ?? (await client.openProject(options.cwd ?? process.cwd())).workspace?.id;
    if (!workspaceId)
      throw {
        code: "WORKSPACE_NOT_FOUND",
        message: "Could not resolve a workspace. Pass --workspace or --cwd.",
      };
    const payload = await client.executeWorkspaceLayout({
      workspaceId,
      command,
      ...(options.hostInstance ? { hostInstanceId: options.hostInstance } : {}),
    });
    if (!payload.ok) throw { code: payload.error.code, message: payload.error.message };
    return { type: "single", data: payload.result as LayoutResult, schema: resultSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

export function placement(options: LayoutOptions): WorkspaceLayoutPlacement | undefined {
  if (options.split) {
    if (!options.targetPane)
      throw { code: "TARGET_PANE_REQUIRED", message: "--split requires --target-pane." };
    return { mode: "split", targetPaneId: options.targetPane, position: options.split };
  }
  return options.pane ? { mode: "pane", paneId: options.pane } : undefined;
}

type OpenTarget = Extract<WorkspaceLayoutCommand, { command: "open_tab" }>["args"]["target"];

export function openTarget(kind: OpenKind, id: string | undefined): OpenTarget {
  if (kind === "new_tab") return { kind };
  if (kind === "files") return { kind };
  if (kind === "changes_tree") return { kind };
  if (kind === "pull_request") return { kind };
  if (kind === "working_diff") return { kind };
  if (!id) throw { code: "TARGET_ID_REQUIRED", message: `${kind} requires an ID or path.` };
  if (kind === "terminal") return { kind, terminalId: id };
  if (kind === "agent") return { kind, agentId: id };
  return { kind: "file", path: id };
}

export function parsePosition(value: string): WorkspaceLayoutPosition {
  const parsed = WorkspaceLayoutPositionSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError("Expected left, right, top, or bottom.");
  return parsed.data;
}

function parseOpenKind(value: string): OpenKind {
  if ((OPEN_KINDS as readonly string[]).includes(value)) return value as OpenKind;
  throw new InvalidArgumentError(`Expected one of: ${OPEN_KINDS.join(", ")}.`);
}
