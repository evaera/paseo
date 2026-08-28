/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";

vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("@/panels/panel-manifest", () => ({
  panelResourceKey: (target: unknown) => JSON.stringify(target),
  panelSupportsHost: () => true,
}));
vi.mock("@/plugins/workspace-panels/locations", () => ({
  panelTargetSupportsHostForWorkspaceKey: () => true,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  DEFAULT_PANE_ID,
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
  type SplitNode,
} from "@/stores/workspace-layout-store";
import { handleWorkspaceLayoutRequest } from "./handler";

const serverId = "server-1";
const workspaceId = "workspace-1";
const options = { hostInstanceId: "host-1", workspaceExists: () => true };

useWorkspaceLayoutStore.persist.setOptions({
  storage: createJSONStorage(() => window.localStorage),
});

describe("workspace layout host handler", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  it.each(["right", "left"] as const)(
    "places a terminal tab in a new %s split without stealing focus",
    (position) => {
      const workspaceKey = `${serverId}:${workspaceId}`;
      const initialTabId = useWorkspaceLayoutStore.getState().openTab({
        workspaceKey,
        target: { kind: "new_tab" },
        intent: "new",
      })!;
      const initialLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
      const initiallyFocusedPaneId = initialLayout.focusedPaneId!;

      const payload = handleWorkspaceLayoutRequest(
        {
          type: "workspace.layout.execute.request",
          requestId: `request-${position}`,
          workspaceId,
          hostInstanceId: "host-1",
          command: {
            command: "open_tab",
            args: {
              target: { kind: "terminal", terminalId: `terminal-${position}` },
              placement: { mode: "split", targetPaneId: DEFAULT_PANE_ID, position },
            },
          },
        },
        serverId,
        options,
      );

      expect(payload.ok).toBe(true);
      if (!payload.ok) return;
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!;
      const terminalTab = collectAllTabs(layout.root).find(
        (tab) => tab.target.kind === "terminal" && tab.target.terminalId === `terminal-${position}`,
      )!;
      const terminalPane = findPaneContainingTab(layout.root, terminalTab.tabId)!;
      const order = paneIds(layout.root);
      const targetIndex = order.indexOf(DEFAULT_PANE_ID);
      const terminalIndex = order.indexOf(terminalPane.id);
      expect(position === "right" ? terminalIndex > targetIndex : terminalIndex < targetIndex).toBe(
        true,
      );
      expect(layout.focusedPaneId).toBe(initiallyFocusedPaneId);
      expect(findPaneContainingTab(layout.root, initialTabId)?.id).toBe(initiallyFocusedPaneId);
      expect(payload.result).toMatchObject({
        command: "open_tab",
        tabId: terminalTab.tabId,
        paneId: terminalPane.id,
      });
    },
  );

  it("rejects unknown workspaces and move-tab no-ops", () => {
    const missing = handleWorkspaceLayoutRequest(
      {
        type: "workspace.layout.execute.request",
        requestId: "missing",
        workspaceId,
        command: { command: "get_layout", args: {} },
      },
      serverId,
      { hostInstanceId: "host-1", workspaceExists: () => false },
    );
    expect(missing).toMatchObject({ ok: false, error: { code: "layout_workspace_not_found" } });

    const workspaceKey = `${serverId}:${workspaceId}`;
    const tabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey,
      target: { kind: "new_tab" },
      intent: "new",
    })!;
    const paneId = findPaneContainingTab(
      useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey]!.root,
      tabId,
    )!.id;
    const noOp = handleWorkspaceLayoutRequest(
      {
        type: "workspace.layout.execute.request",
        requestId: "noop",
        workspaceId,
        command: { command: "move_tab", args: { tabId, paneId } },
      },
      serverId,
      options,
    );
    expect(noOp).toMatchObject({ ok: false, error: { code: "layout_invalid_operation" } });
  });
});

function paneIds(node: SplitNode): string[] {
  return node.kind === "pane"
    ? [node.pane.id]
    : node.group.children.flatMap((child) => paneIds(child));
}
