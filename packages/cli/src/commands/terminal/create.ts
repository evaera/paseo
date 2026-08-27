import type { Command } from "commander";
import type { WorkspaceLayoutNode } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import type { SingleResult, CommandError } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow, toTerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  cwd?: string;
  name?: string;
  pane?: string;
  split?: "left" | "right" | "top" | "bottom";
  targetPane?: string;
  hostInstance?: string;
}

// eslint-disable-next-line complexity -- Terminal creation keeps preflight, placement, and orphan cleanup in one transaction-shaped flow.
export async function runCreateCommand(
  options: TerminalCreateOptions,
  _command: Command,
): Promise<SingleResult<TerminalRow>> {
  const { client } = await connectTerminalClient(options.host);
  const cwd = options.cwd ?? process.cwd();

  try {
    const opened = await client.openProject(cwd);
    if (!opened.workspace) {
      const error: CommandError = {
        code: "WORKSPACE_OPEN_FAILED",
        message: opened.error ?? "Failed to open workspace",
      };
      throw error;
    }

    if (options.split && !options.targetPane) {
      const error: CommandError = {
        code: "TARGET_PANE_REQUIRED",
        message: "--split requires --target-pane",
      };
      throw error;
    }
    if (options.pane || options.split) {
      const inspection = await client.executeWorkspaceLayout({
        workspaceId: opened.workspace.id,
        command: { command: "get_layout", args: {} },
        ...(options.hostInstance ? { hostInstanceId: options.hostInstance } : {}),
      });
      if (!inspection.ok) {
        const error: CommandError = {
          code: inspection.error.code,
          message: inspection.error.message,
        };
        throw error;
      }
      const targetPaneId = options.split ? options.targetPane : options.pane;
      if (!targetPaneId || !hasPane(inspection.result.layout.root, targetPaneId)) {
        const error: CommandError = {
          code: "LAYOUT_PANE_NOT_FOUND",
          message: `Pane ${targetPaneId ?? ""} was not found.`,
        };
        throw error;
      }
    }

    const payload = await client.createTerminal(cwd, options.name, undefined, {
      workspaceId: opened.workspace.id,
    });
    if (!payload.terminal) {
      const error: CommandError = {
        code: "TERMINAL_CREATE_FAILED",
        message: payload.error ?? "Failed to create terminal",
      };
      throw error;
    }
    if (options.pane || options.split) {
      const layout = await client.executeWorkspaceLayout({
        workspaceId: opened.workspace.id,
        ...(options.hostInstance ? { hostInstanceId: options.hostInstance } : {}),
        command: {
          command: "open_tab",
          args: {
            target: { kind: "terminal", terminalId: payload.terminal.id },
            placement: options.split
              ? { mode: "split", targetPaneId: options.targetPane!, position: options.split }
              : { mode: "pane", paneId: options.pane! },
          },
        },
      });
      if (!layout.ok) {
        await client.killTerminal(payload.terminal.id).catch(() => {});
        const error: CommandError = { code: layout.error.code, message: layout.error.message };
        throw error;
      }
    }
    return {
      type: "single",
      data: toTerminalRow(payload.terminal),
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await client.close().catch(() => {});
  }
}

function hasPane(node: WorkspaceLayoutNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.pane.paneId === paneId
    : node.group.children.some((child) => hasPane(child, paneId));
}
