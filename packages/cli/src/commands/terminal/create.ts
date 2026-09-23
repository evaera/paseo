import type { Command } from "commander";
import type { WorkspaceLayoutNode } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import type { SingleResult, CommandError } from "../../output/index.js";
import {
  connectTerminalClient,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";
import { terminalSchema, type TerminalRow } from "./schema.js";

export interface TerminalCreateOptions extends TerminalCommandOptions {
  workspace?: string;
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
  const { client, daemonClient, close } = await connectTerminalClient(options.daemonTarget);
  try {
    if (options.split && !options.targetPane) {
      const error: CommandError = {
        code: "TARGET_PANE_REQUIRED",
        message: "--split requires --target-pane",
      };
      throw error;
    }
    const cwd = options.cwd ?? (options.workspace ? undefined : process.cwd());
    const workspaceId =
      options.workspace ?? (await client.workspaces.open(options.cwd ?? process.cwd())).id;

    if (options.pane || options.split) {
      const inspection = await daemonClient.executeWorkspaceLayout({
        workspaceId,
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

    const terminal = await client.terminals.create({
      workspaceId,
      cwd,
      name: options.name,
    });
    const snapshot = terminal.current();
    if (!snapshot) throw new Error("The daemon did not create a terminal");

    if (options.pane || options.split) {
      try {
        const layout = await daemonClient.executeWorkspaceLayout({
          workspaceId,
          ...(options.hostInstance ? { hostInstanceId: options.hostInstance } : {}),
          command: {
            command: "open_tab",
            args: {
              target: { kind: "terminal", terminalId: snapshot.id },
              placement: options.split
                ? { mode: "split", targetPaneId: options.targetPane!, position: options.split }
                : { mode: "pane", paneId: options.pane! },
            },
          },
        });
        if (!layout.ok) {
          const error: CommandError = { code: layout.error.code, message: layout.error.message };
          throw error;
        }
      } catch (error) {
        await terminal.kill().catch(() => {});
        throw error;
      }
    }
    return {
      type: "single",
      data: snapshot,
      schema: terminalSchema,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CREATE_FAILED", "create terminal", err);
  } finally {
    await close().catch(() => {});
  }
}

function hasPane(node: WorkspaceLayoutNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.pane.paneId === paneId
    : node.group.children.some((child) => hasPane(child, paneId));
}
