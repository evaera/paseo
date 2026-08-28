import type {
  WorkspaceLayoutCommand,
  WorkspaceLayoutExecuteRequest,
  WorkspaceLayoutExecuteResponse,
  WorkspaceLayoutPlacement,
  WorkspaceLayoutSnapshot,
} from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  createDefaultLayout,
  findPaneById,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

interface LayoutClient {
  on(
    type: "workspace.layout.execute.request",
    handler: (message: WorkspaceLayoutExecuteRequest) => void,
  ): () => void;
  sendWorkspaceLayoutExecuteResponse(response: WorkspaceLayoutExecuteResponse): void;
}
type LayoutPayload = WorkspaceLayoutExecuteResponse["payload"];
type LayoutFailure = Extract<LayoutPayload, { ok: false }>;
type CommandResult =
  | { ok: false; payload: LayoutFailure }
  | { ok: true; tabId?: string; paneId?: string };

interface WorkspaceLayoutHandlerOptions {
  hostInstanceId: string;
  workspaceExists?: (serverId: string, workspaceId: string) => boolean;
}

export function mountWorkspaceLayoutHandler(
  client: unknown,
  serverId: string,
  options: WorkspaceLayoutHandlerOptions,
): () => void {
  const typedClient = client as LayoutClient;
  return typedClient.on("workspace.layout.execute.request", (request) => {
    typedClient.sendWorkspaceLayoutExecuteResponse({
      type: "workspace.layout.execute.response",
      payload: handleWorkspaceLayoutRequest(request, serverId, options),
    });
  });
}

export function handleWorkspaceLayoutRequest(
  request: WorkspaceLayoutExecuteRequest,
  serverId: string,
  options: WorkspaceLayoutHandlerOptions,
): LayoutPayload {
  try {
    const workspaceExists = options.workspaceExists ?? defaultWorkspaceExists;
    if (request.hostInstanceId && request.hostInstanceId !== options.hostInstanceId) {
      return failure(
        request.requestId,
        "layout_unsupported",
        "The layout request was routed to a different host instance.",
        options.hostInstanceId,
      );
    }
    if (!workspaceExists(serverId, request.workspaceId)) {
      return failure(
        request.requestId,
        "layout_workspace_not_found",
        "Workspace is not available on this layout host.",
        options.hostInstanceId,
      );
    }
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId,
      workspaceId: request.workspaceId,
    });
    if (!workspaceKey)
      return failure(
        request.requestId,
        "layout_workspace_not_found",
        "Workspace not found.",
        options.hostInstanceId,
      );
    const previousFocus = captureFocus(workspaceKey);
    const result = executeCommand(
      request.requestId,
      workspaceKey,
      request.command,
      options.hostInstanceId,
    );
    if (!result.ok) return result.payload;
    restoreFocus(workspaceKey, previousFocus);
    return {
      status: "success",
      requestId: request.requestId,
      hostInstanceId: options.hostInstanceId,
      ok: true,
      result: {
        command: request.command.command,
        layout: snapshot(request.workspaceId, currentLayout(workspaceKey)),
        ...(result.tabId ? { tabId: result.tabId } : {}),
        ...(result.paneId ? { paneId: result.paneId } : {}),
      },
    };
  } catch (error) {
    return failure(
      request.requestId,
      "layout_unknown_error",
      error instanceof Error ? error.message : String(error),
      options.hostInstanceId,
    );
  }
}

function executeCommand(
  requestId: string,
  workspaceKey: string,
  command: WorkspaceLayoutCommand,
  hostInstanceId: string,
): CommandResult {
  const store = useWorkspaceLayoutStore.getState();
  switch (command.command) {
    case "get_layout":
      return { ok: true };
    case "open_tab":
      return openTab(requestId, workspaceKey, command.args, hostInstanceId);
    case "split_pane": {
      const paneId = store.splitPaneEmpty(workspaceKey, command.args);
      return paneId
        ? { ok: true, paneId }
        : failed(
            requestId,
            "layout_pane_not_found",
            "Target pane was not found or cannot be split.",
            hostInstanceId,
          );
    }
    case "move_tab": {
      const layout = currentLayout(workspaceKey);
      const sourcePane = findPaneContainingTab(layout.root, command.args.tabId);
      if (!sourcePane)
        return failed(requestId, "layout_tab_not_found", "Tab not found.", hostInstanceId);
      if (!findPaneById(layout.root, command.args.paneId))
        return failed(
          requestId,
          "layout_pane_not_found",
          "Destination pane not found.",
          hostInstanceId,
        );
      if (sourcePane.id === command.args.paneId)
        return failed(
          requestId,
          "layout_invalid_operation",
          "Tab is already in the destination pane.",
          hostInstanceId,
        );
      store.moveTabToPane(workspaceKey, command.args.tabId, command.args.paneId);
      return { ok: true, tabId: command.args.tabId, paneId: command.args.paneId };
    }
    case "move_pane": {
      const moved = store.movePane(
        workspaceKey,
        command.args.paneId,
        command.args.targetPaneId,
        command.args.position,
      );
      return moved
        ? { ok: true, paneId: command.args.paneId }
        : failed(
            requestId,
            "layout_invalid_operation",
            "Pane move is invalid or references an unknown pane.",
            hostInstanceId,
          );
    }
  }
}

function openTab(
  requestId: string,
  workspaceKey: string,
  args: Extract<WorkspaceLayoutCommand, { command: "open_tab" }>["args"],
  hostInstanceId: string,
): CommandResult {
  const store = useWorkspaceLayoutStore.getState();
  const placement = args.placement;
  const tabId =
    store.openTab({
      workspaceKey,
      target: args.target,
      intent: "background",
      placement:
        placement?.mode === "split"
          ? { mode: "pane", paneId: placement.targetPaneId }
          : toStorePlacement(placement),
    }) ?? undefined;
  if (!tabId) {
    return failed(
      requestId,
      placement?.mode === "split" ? "layout_pane_not_found" : "layout_invalid_operation",
      "Could not open the tab in the requested pane.",
      hostInstanceId,
    );
  }
  const paneId =
    placement?.mode === "split"
      ? (store.splitPane(workspaceKey, {
          tabId,
          targetPaneId: placement.targetPaneId,
          position: placement.position,
        }) ?? undefined)
      : findPaneContainingTab(currentLayout(workspaceKey).root, tabId)?.id;
  if (!paneId) {
    store.closeTab(workspaceKey, tabId);
    return failed(
      requestId,
      "layout_invalid_operation",
      "Could not create the requested split.",
      hostInstanceId,
    );
  }
  return { ok: true, tabId, paneId };
}

function toStorePlacement(placement: WorkspaceLayoutPlacement | undefined) {
  if (!placement || placement.mode === "focused") return { mode: "focused" } as const;
  if (placement.mode === "pane") return placement;
  return { mode: "pane", paneId: placement.targetPaneId } as const;
}

function currentLayout(workspaceKey: string): WorkspaceLayout {
  return (
    useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey] ?? createDefaultLayout()
  );
}

function snapshot(workspaceId: string, layout: WorkspaceLayout): WorkspaceLayoutSnapshot {
  const tabs = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const visit = (node: SplitNode): WorkspaceLayoutSnapshot["root"] =>
    node.kind === "pane"
      ? {
          kind: "pane",
          pane: {
            paneId: node.pane.id,
            focusedTabId: node.pane.focusedTabId,
            ...(node.pane.hidden !== undefined ? { hidden: node.pane.hidden } : {}),
            tabs: node.pane.tabIds.flatMap((tabId) => {
              const tab = tabs.get(tabId);
              return tab ? [{ tabId, target: tab.target }] : [];
            }),
          },
        }
      : {
          kind: "group",
          group: {
            groupId: node.group.id,
            direction: node.group.direction,
            sizes: node.group.sizes,
            children: node.group.children.map(visit),
          },
        };
  return { workspaceId, focusedPaneId: layout.focusedPaneId, root: visit(layout.root) };
}

function failed(
  requestId: string,
  code: LayoutFailure["error"]["code"],
  message: string,
  hostInstanceId: string,
): CommandResult {
  return { ok: false, payload: failure(requestId, code, message, hostInstanceId) };
}

function failure(
  requestId: string,
  code: LayoutFailure["error"]["code"],
  message: string,
  hostInstanceId: string,
): LayoutFailure {
  return { status: "error", requestId, hostInstanceId, ok: false, error: { code, message } };
}

function defaultWorkspaceExists(serverId: string, workspaceId: string): boolean {
  return useSessionStore.getState().sessions[serverId]?.workspaces.has(workspaceId) === true;
}

function captureFocus(workspaceKey: string): { paneId: string | null; tabId: string | null } {
  const layout = currentLayout(workspaceKey);
  const pane = layout.focusedPaneId ? findPaneById(layout.root, layout.focusedPaneId) : null;
  return { paneId: layout.focusedPaneId, tabId: pane?.focusedTabId ?? null };
}

function restoreFocus(
  workspaceKey: string,
  previous: { paneId: string | null; tabId: string | null },
): void {
  const store = useWorkspaceLayoutStore.getState();
  const layout = currentLayout(workspaceKey);
  const pane =
    (previous.paneId ? findPaneById(layout.root, previous.paneId) : null) ??
    (previous.tabId ? findPaneContainingTab(layout.root, previous.tabId) : null);
  if (pane) store.focusPane(workspaceKey, pane.id);
}
