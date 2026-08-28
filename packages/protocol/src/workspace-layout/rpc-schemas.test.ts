import { describe, expect, it } from "vitest";
import { BrowserAutomationNewTabCommandSchema } from "../browser-automation/rpc-schemas.js";
import {
  WorkspaceLayoutExecuteRequestSchema,
  WorkspaceLayoutExecuteResponseSchema,
} from "./rpc-schemas.js";

describe("workspace layout RPC schemas", () => {
  it("keeps browser creation policy-gated while supporting right-split placement", () => {
    expect(
      BrowserAutomationNewTabCommandSchema.parse({
        command: "new_tab",
        args: {
          url: "https://example.com",
          placement: { mode: "split", targetPaneId: "pane-1", position: "right" },
        },
      }).args.placement,
    ).toEqual({ mode: "split", targetPaneId: "pane-1", position: "right" });

    expect(
      WorkspaceLayoutExecuteRequestSchema.safeParse({
        type: "workspace.layout.execute.request",
        requestId: "request-1",
        workspaceId: "workspace-1",
        command: {
          command: "open_tab",
          args: { target: { kind: "browser", url: "https://example.com" } },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts stable pane and tab IDs in an inspection response", () => {
    expect(
      WorkspaceLayoutExecuteResponseSchema.safeParse({
        type: "workspace.layout.execute.response",
        payload: {
          status: "success",
          requestId: "request-1",
          hostInstanceId: "host-1",
          ok: true,
          result: {
            command: "get_layout",
            layout: {
              workspaceId: "workspace-1",
              focusedPaneId: "pane-1",
              root: {
                kind: "pane",
                pane: {
                  paneId: "pane-1",
                  focusedTabId: "tab-1",
                  tabs: [{ tabId: "tab-1", target: { kind: "terminal", terminalId: "term-1" } }],
                },
              },
            },
          },
        },
      }).success,
    ).toBe(true);
  });
});
