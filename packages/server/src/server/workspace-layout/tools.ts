import { z } from "zod";
import {
  WorkspaceLayoutOpenTargetSchema,
  WorkspaceLayoutPlacementSchema,
  WorkspaceLayoutPositionSchema,
  type WorkspaceLayoutCommand,
} from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { WorkspaceLayoutBroker, WorkspaceLayoutResponsePayload } from "./broker.js";

const HostInstanceInput = { hostInstanceId: z.string().min(1).optional() };

interface CallerAgentContext {
  id: string;
  workspaceId?: string;
}

export function registerWorkspaceLayoutTools(options: {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Catalog validates tool inputs before handlers run.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  broker: Pick<WorkspaceLayoutBroker, "execute">;
  resolveCallerAgent: () => CallerAgentContext | null;
}): void {
  const register = (
    name: string,
    description: string,
    inputSchema: PaseoToolConfig["inputSchema"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Each registered schema validates this input.
    build: (input: any) => WorkspaceLayoutCommand,
  ) => {
    options.registerTool(name, { title: description, description, inputSchema }, async (input) =>
      execute(options, build(input), input.hostInstanceId),
    );
  };
  register(
    "workspace_layout_inspect",
    "Inspect this workspace's pane tree, stable pane IDs, and tab IDs.",
    HostInstanceInput,
    () => ({ command: "get_layout", args: {} }),
  );
  register(
    "workspace_layout_open_tab",
    "Open a non-browser workspace tab, optionally in an existing pane or a newly created split. Use browser_new_tab for browser tabs.",
    {
      target: WorkspaceLayoutOpenTargetSchema,
      placement: WorkspaceLayoutPlacementSchema.optional(),
      ...HostInstanceInput,
    },
    ({ target, placement }) => ({
      command: "open_tab",
      args: {
        target,
        ...(placement ? { placement } : {}),
      },
    }),
  );
  register(
    "workspace_layout_split_pane",
    "Create an empty pane beside an existing pane.",
    {
      targetPaneId: z.string().min(1),
      position: WorkspaceLayoutPositionSchema,
      ...HostInstanceInput,
    },
    ({ targetPaneId, position }) => ({ command: "split_pane", args: { targetPaneId, position } }),
  );
  register(
    "workspace_layout_move_tab",
    "Move a tab to an existing pane using IDs from workspace_layout_inspect.",
    { tabId: z.string().min(1), paneId: z.string().min(1), ...HostInstanceInput },
    ({ tabId, paneId }) => ({ command: "move_tab", args: { tabId, paneId } }),
  );
  register(
    "workspace_layout_move_pane",
    "Move a pane beside another pane while preserving its pane and tab IDs.",
    {
      paneId: z.string().min(1),
      targetPaneId: z.string().min(1),
      position: WorkspaceLayoutPositionSchema,
      ...HostInstanceInput,
    },
    ({ paneId, targetPaneId, position }) => ({
      command: "move_pane",
      args: { paneId, targetPaneId, position },
    }),
  );
}

async function execute(
  options: {
    broker: Pick<WorkspaceLayoutBroker, "execute">;
    resolveCallerAgent: () => CallerAgentContext | null;
  },
  command: WorkspaceLayoutCommand,
  hostInstanceId?: string,
): Promise<PaseoToolResult> {
  const caller = options.resolveCallerAgent();
  if (!caller?.workspaceId) {
    return result({
      status: "error",
      requestId: "layout_context",
      ok: false,
      error: {
        code: "layout_workspace_not_found",
        message: "This tool requires an agent started from a Paseo workspace.",
      },
    });
  }
  return result(
    await options.broker.execute({
      workspaceId: caller.workspaceId,
      agentId: caller.id,
      ...(hostInstanceId ? { hostInstanceId } : {}),
      command,
    }),
  );
}

function result(payload: WorkspaceLayoutResponsePayload): PaseoToolResult {
  return {
    content: [
      {
        type: "text",
        text: payload.ok ? JSON.stringify(payload.result, null, 2) : payload.error.message,
      },
    ],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true }),
  };
}
