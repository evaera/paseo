import { z } from "zod";

export const WorkspaceLayoutPositionSchema = z.enum(["left", "right", "top", "bottom"]);

export const WorkspaceLayoutPlacementSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("focused") }).strict(),
  z.object({ mode: z.literal("pane"), paneId: z.string().min(1) }).strict(),
  z
    .object({
      mode: z.literal("split"),
      targetPaneId: z.string().min(1),
      position: WorkspaceLayoutPositionSchema,
    })
    .strict(),
]);

export const WorkspaceLayoutTabTargetSchema = z.object({ kind: z.string().min(1) }).passthrough();

export const WorkspaceLayoutOpenTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_tab") }).strict(),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("terminal"), terminalId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("changes_tree") }).strict(),
  z.object({ kind: z.literal("files") }).strict(),
  z.object({ kind: z.literal("pull_request") }).strict(),
  z.object({ kind: z.literal("working_diff") }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
]);

export const WorkspaceLayoutCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("get_layout"), args: z.object({}).strict() }).strict(),
  z
    .object({
      command: z.literal("open_tab"),
      args: z
        .object({
          target: WorkspaceLayoutOpenTargetSchema,
          placement: WorkspaceLayoutPlacementSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("split_pane"),
      args: z
        .object({ targetPaneId: z.string().min(1), position: WorkspaceLayoutPositionSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("move_tab"),
      args: z.object({ tabId: z.string().min(1), paneId: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("move_pane"),
      args: z
        .object({
          paneId: z.string().min(1),
          targetPaneId: z.string().min(1),
          position: WorkspaceLayoutPositionSchema,
        })
        .strict(),
    })
    .strict(),
]);

export interface WorkspaceLayoutPane {
  paneId: string;
  focusedTabId: string | null;
  hidden?: boolean;
  tabs: Array<{ tabId: string; target: { kind: string } }>;
}

export type WorkspaceLayoutNode =
  | { kind: "pane"; pane: WorkspaceLayoutPane }
  | {
      kind: "group";
      group: {
        groupId: string;
        direction: "horizontal" | "vertical";
        sizes: number[];
        children: WorkspaceLayoutNode[];
      };
    };

export const WorkspaceLayoutPaneSchema: z.ZodType<WorkspaceLayoutPane> = z.object({
  paneId: z.string().min(1),
  focusedTabId: z.string().min(1).nullable(),
  hidden: z.boolean().optional(),
  tabs: z.array(
    z.object({
      tabId: z.string().min(1),
      target: WorkspaceLayoutTabTargetSchema,
    }),
  ),
});

export const WorkspaceLayoutNodeSchema: z.ZodType<WorkspaceLayoutNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pane"), pane: WorkspaceLayoutPaneSchema }),
    z.object({
      kind: z.literal("group"),
      group: z.object({
        groupId: z.string().min(1),
        direction: z.enum(["horizontal", "vertical"]),
        sizes: z.array(z.number()),
        children: z.array(WorkspaceLayoutNodeSchema),
      }),
    }),
  ]),
);

export const WorkspaceLayoutSnapshotSchema = z.object({
  workspaceId: z.string().min(1),
  focusedPaneId: z.string().min(1).nullable(),
  root: WorkspaceLayoutNodeSchema,
});

export const WorkspaceLayoutExecuteRequestSchema = z
  .object({
    type: z.literal("workspace.layout.execute.request"),
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    agentId: z.string().min(1).optional(),
    hostInstanceId: z.string().min(1).optional(),
    command: WorkspaceLayoutCommandSchema,
  })
  .strict();

const WorkspaceLayoutSuccessPayloadSchema = z.object({
  status: z.literal("success"),
  requestId: z.string().min(1),
  hostInstanceId: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    command: z.enum(["get_layout", "open_tab", "split_pane", "move_tab", "move_pane"]),
    layout: WorkspaceLayoutSnapshotSchema,
    tabId: z.string().min(1).optional(),
    paneId: z.string().min(1).optional(),
  }),
});

const WorkspaceLayoutFailurePayloadSchema = z.object({
  status: z.literal("error"),
  requestId: z.string().min(1),
  hostInstanceId: z.string().min(1).optional(),
  ok: z.literal(false),
  error: z.object({
    code: z.enum([
      "layout_no_host",
      "layout_ambiguous_host",
      "layout_workspace_not_found",
      "layout_pane_not_found",
      "layout_tab_not_found",
      "layout_invalid_operation",
      "layout_timeout",
      "layout_unsupported",
      "layout_unknown_error",
    ]),
    message: z.string().min(1),
    retryable: z.boolean().optional(),
  }),
});

export const WorkspaceLayoutExecuteResponseSchema = z.object({
  type: z.literal("workspace.layout.execute.response"),
  payload: z.discriminatedUnion("status", [
    WorkspaceLayoutSuccessPayloadSchema,
    WorkspaceLayoutFailurePayloadSchema,
  ]),
});

export type WorkspaceLayoutPosition = z.infer<typeof WorkspaceLayoutPositionSchema>;
export type WorkspaceLayoutPlacement = z.infer<typeof WorkspaceLayoutPlacementSchema>;
export type WorkspaceLayoutCommand = z.infer<typeof WorkspaceLayoutCommandSchema>;
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchema>;
export type WorkspaceLayoutExecuteRequest = z.infer<typeof WorkspaceLayoutExecuteRequestSchema>;
export type WorkspaceLayoutExecuteResponse = z.infer<typeof WorkspaceLayoutExecuteResponseSchema>;
