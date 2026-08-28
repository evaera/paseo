import { describe, expect, it } from "vitest";
import { validateWSOutboundMessage } from "./ws-outbound.js";

const layout = {
  workspaceId: "workspace-1",
  focusedPaneId: "pane-1",
  root: {
    kind: "pane" as const,
    pane: { paneId: "pane-1", focusedTabId: null, tabs: [] },
  },
};

describe("generated outbound workspace layout validation", () => {
  it("accepts success and error responses with a string discriminator", () => {
    const payloads = [
      {
        status: "success",
        requestId: "request-1",
        hostInstanceId: "host-1",
        ok: true,
        result: { command: "get_layout", layout },
      },
      {
        status: "error",
        requestId: "request-2",
        hostInstanceId: "host-1",
        ok: false,
        error: { code: "layout_pane_not_found", message: "Pane not found." },
      },
    ];
    for (const payload of payloads) {
      expect(
        validateWSOutboundMessage({
          type: "session",
          message: { type: "workspace.layout.execute.response", payload },
        }).success,
      ).toBe(true);
    }
  });
});
