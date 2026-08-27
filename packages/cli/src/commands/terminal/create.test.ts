import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import { connectTerminalClient } from "./shared.js";
import { runCreateCommand } from "./create.js";

vi.mock("./shared.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./shared.js")>();
  return { ...original, connectTerminalClient: vi.fn() };
});

const layout = {
  workspaceId: "workspace-1",
  focusedPaneId: "pane-1",
  root: { kind: "pane" as const, pane: { paneId: "pane-1", focusedTabId: null, tabs: [] } },
};

function createClient() {
  return {
    openProject: vi.fn(async () => ({ workspace: { id: "workspace-1" } })),
    executeWorkspaceLayout: vi
      .fn()
      .mockResolvedValueOnce({
        status: "success",
        requestId: "inspect",
        hostInstanceId: "host-1",
        ok: true,
        result: { command: "get_layout", layout },
      })
      .mockResolvedValueOnce({
        status: "success",
        requestId: "open",
        hostInstanceId: "host-1",
        ok: true,
        result: { command: "open_tab", layout, tabId: "tab-1", paneId: "pane-1" },
      }),
    createTerminal: vi.fn(async () => ({
      terminal: { id: "terminal-1", workspaceId: "workspace-1", cwd: "/repo", name: null },
    })),
    killTerminal: vi.fn(async () => ({ success: true })),
    close: vi.fn(async () => undefined),
  };
}

describe("terminal create layout placement", () => {
  beforeEach(() => vi.clearAllMocks());

  it("validates the pane before creation and places the terminal", async () => {
    const client = createClient();
    vi.mocked(connectTerminalClient).mockResolvedValue({
      client: client as never,
      daemonHost: "host",
    });
    await runCreateCommand({ cwd: "/repo", split: "right", targetPane: "pane-1" }, {} as Command);
    expect(client.createTerminal).toHaveBeenCalledOnce();
    expect(client.executeWorkspaceLayout).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      command: {
        command: "open_tab",
        args: {
          target: { kind: "terminal", terminalId: "terminal-1" },
          placement: { mode: "split", targetPaneId: "pane-1", position: "right" },
        },
      },
    });
  });

  it("does not create a terminal for an unknown target pane", async () => {
    const client = createClient();
    vi.mocked(connectTerminalClient).mockResolvedValue({
      client: client as never,
      daemonHost: "host",
    });
    await expect(
      runCreateCommand({ cwd: "/repo", pane: "missing" }, {} as Command),
    ).rejects.toMatchObject({ code: "LAYOUT_PANE_NOT_FOUND" });
    expect(client.createTerminal).not.toHaveBeenCalled();
  });
});
