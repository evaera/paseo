import { describe, expect, it } from "vitest";
import type { WorkspaceLayoutExecuteRequest } from "@getpaseo/protocol/workspace-layout/rpc-schemas";
import { WorkspaceLayoutBroker } from "./broker.js";

function success(request: WorkspaceLayoutExecuteRequest, hostInstanceId = "host-1") {
  return {
    type: "workspace.layout.execute.response" as const,
    payload: {
      status: "success" as const,
      requestId: request.requestId,
      hostInstanceId,
      ok: true as const,
      result: {
        command: "get_layout" as const,
        layout: {
          workspaceId: request.workspaceId,
          focusedPaneId: null,
          root: { kind: "pane" as const, pane: { paneId: "pane-1", focusedTabId: null, tabs: [] } },
        },
      },
    },
  };
}

describe("WorkspaceLayoutBroker", () => {
  it("uses an internal correlation ID and binds responses to the routed host", async () => {
    const broker = new WorkspaceLayoutBroker({
      createRequestId: () => "internal-1",
      defaultTimeoutMs: 100,
    });
    const requests: WorkspaceLayoutExecuteRequest[] = [];
    broker.registerClient({
      clientId: "app-1",
      hostInstanceId: "host-1",
      hostKind: "app",
      sendWorkspaceLayoutRequest: (request) => {
        requests.push(request);
        expect(
          broker.receiveResponse(success(request), { clientId: "spoof", hostInstanceId: "host-1" }),
        ).toBe(false);
        expect(
          broker.receiveResponse(success(request), { clientId: "app-1", hostInstanceId: "host-1" }),
        ).toBe(true);
      },
    });

    const result = await broker.execute({
      requestId: "external-1",
      workspaceId: "workspace-1",
      command: { command: "get_layout", args: {} },
    });
    expect(result).toMatchObject({ ok: true, requestId: "external-1", hostInstanceId: "host-1" });
    expect(requests[0]?.requestId).toBe("internal-1");
  });

  it("fails ambiguous routing unless a host instance is selected", async () => {
    const broker = new WorkspaceLayoutBroker({ createRequestId: () => "internal-1" });
    for (const hostInstanceId of ["host-1", "host-2"]) {
      broker.registerClient({
        clientId: hostInstanceId,
        hostInstanceId,
        hostKind: "app",
        sendWorkspaceLayoutRequest: () => {},
      });
    }
    await expect(
      broker.execute({ workspaceId: "workspace-1", command: { command: "get_layout", args: {} } }),
    ).resolves.toMatchObject({ ok: false, error: { code: "layout_ambiguous_host" } });
  });

  it("returns a retryable error without a connected app", async () => {
    const result = await new WorkspaceLayoutBroker({ createRequestId: () => "request-1" }).execute({
      workspaceId: "workspace-1",
      command: { command: "get_layout", args: {} },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "layout_no_host", retryable: true } });
  });
});
