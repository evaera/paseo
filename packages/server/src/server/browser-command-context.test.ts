import type { BrowserCommandExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { describe, expect, test } from "vitest";
import { hasInvalidBrowserCommandContext } from "./browser-command-context.js";

const baseRequest: BrowserCommandExecuteRequest = {
  type: "browser.command.execute.request",
  requestId: "request-1",
  command: { command: "list_tabs", args: {} },
};

function request(
  context: Pick<BrowserCommandExecuteRequest, "agentId" | "cwd" | "workspaceId">,
): BrowserCommandExecuteRequest {
  return { ...baseRequest, ...context };
}

describe("hasInvalidBrowserCommandContext", () => {
  test("rejects an unresolved workspace", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({ workspaceId: "workspace-1" }),
        workspace: null,
        agent: null,
      }),
    ).toBe(true);
  });

  test("rejects a cwd that does not match the workspace", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({ workspaceId: "workspace-1", cwd: "/requested" }),
        workspace: { cwd: "/actual" },
        agent: null,
      }),
    ).toBe(true);
  });

  test("rejects a missing agent", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({ agentId: "agent-1" }),
        workspace: null,
        agent: null,
      }),
    ).toBe(true);
  });

  test("rejects an agent from another workspace", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({ agentId: "agent-1", workspaceId: "workspace-1" }),
        workspace: { cwd: "/workspace" },
        agent: { cwd: "/workspace", workspaceId: "workspace-2" },
      }),
    ).toBe(true);
  });

  test("rejects an agent with a different cwd", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({
          agentId: "agent-1",
          workspaceId: "workspace-1",
          cwd: "/workspace",
        }),
        workspace: { cwd: "/workspace" },
        agent: { cwd: "/other", workspaceId: "workspace-1" },
      }),
    ).toBe(true);
  });

  test("accepts matching workspace and agent context", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: request({
          agentId: "agent-1",
          workspaceId: "workspace-1",
          cwd: "/workspace",
        }),
        workspace: { cwd: "/workspace" },
        agent: { cwd: "/workspace", workspaceId: "workspace-1" },
      }),
    ).toBe(false);
  });

  test("accepts omitted optional context from a trusted CLI", () => {
    expect(
      hasInvalidBrowserCommandContext({
        request: baseRequest,
        workspace: null,
        agent: null,
      }),
    ).toBe(false);
  });
});
