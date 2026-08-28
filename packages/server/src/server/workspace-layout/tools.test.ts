import { describe, expect, it } from "vitest";
import type { WorkspaceLayoutCommand } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import type { PaseoToolExecutionContext, PaseoToolResult } from "../agent/tools/types.js";
import { registerWorkspaceLayoutTools } from "./tools.js";

describe("workspace layout tools", () => {
  it("exposes transport-neutral inspect and mutation tools", async () => {
    const tools = new Map<
      string,
      (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>
    >();
    const calls: Array<{ command: WorkspaceLayoutCommand; hostInstanceId?: string }> = [];
    registerWorkspaceLayoutTools({
      registerTool: (name, _config, handler) => tools.set(name, handler),
      broker: {
        execute: async (input) => {
          calls.push(input);
          return {
            status: "success" as const,
            requestId: "request-1",
            hostInstanceId: "host-1",
            ok: true as const,
            result: {
              command: input.command.command,
              layout: {
                workspaceId: input.workspaceId,
                focusedPaneId: null,
                root: {
                  kind: "pane" as const,
                  pane: { paneId: "pane-1", focusedTabId: null, tabs: [] },
                },
              },
            },
          };
        },
      },
      resolveCallerAgent: () => ({ id: "agent-1", workspaceId: "workspace-1" }),
    });

    expect([...tools.keys()]).toEqual([
      "workspace_layout_inspect",
      "workspace_layout_open_tab",
      "workspace_layout_split_pane",
      "workspace_layout_move_tab",
      "workspace_layout_move_pane",
    ]);
    const result = await tools.get("workspace_layout_open_tab")!(
      {
        target: { kind: "terminal", terminalId: "terminal-1" },
        placement: { mode: "split", targetPaneId: "pane-1", position: "right" },
        hostInstanceId: "host-1",
      },
      {},
    );
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({
      hostInstanceId: "host-1",
      command: {
        command: "open_tab",
        args: { placement: { position: "right" } },
      },
    });
  });
});
