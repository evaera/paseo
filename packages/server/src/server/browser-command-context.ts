import type { BrowserCommandExecuteRequest } from "@getpaseo/protocol/browser-automation/rpc-schemas";

export function hasInvalidBrowserCommandContext(input: {
  request: BrowserCommandExecuteRequest;
  workspace: { cwd: string } | null;
  agent: { cwd: string; workspaceId?: string } | null | undefined;
}): boolean {
  const { request, workspace, agent } = input;
  if (request.workspaceId !== undefined && !workspace) return true;
  if (request.cwd !== undefined && workspace?.cwd !== request.cwd) return true;
  if (request.agentId === undefined) return false;
  if (!agent) return true;
  if (request.workspaceId !== undefined && agent.workspaceId !== request.workspaceId) return true;
  return request.cwd !== undefined && agent.cwd !== request.cwd;
}
