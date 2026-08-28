import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import {
  ensureResidentBrowserWebview as ensureResidentBrowserWebviewDefault,
  removeResidentBrowserWebview,
  resizeResidentBrowserWebview,
} from "@/desktop/browser/resident-webviews";
import {
  createFixedBrowserViewport,
  createWorkspaceBrowser,
  getBrowserRecord,
  useBrowserStore,
} from "@/desktop/browser/store";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];
type BrowserAutomationFailurePayload = Extract<BrowserAutomationResponsePayload, { ok: false }>;
type BrowserAutomationErrorCode = BrowserAutomationFailurePayload["error"]["code"];

interface BrowserAutomationClient {
  on(
    type: "browser.automation.execute.request",
    handler: (message: BrowserAutomationExecuteRequest) => void,
  ): () => void;
  sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void;
}

export interface BrowserAutomationHandlerOptions {
  client: BrowserAutomationClient;
  serverId?: string;
  getHost?: () => DesktopHostBridge | null;
  ensureResidentBrowserWebview?: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}

export function mountBrowserAutomationHandler(
  options: BrowserAutomationHandlerOptions,
): () => void {
  const getHost = options.getHost ?? getDesktopHost;
  const unsubscribe = options.client.on("browser.automation.execute.request", (request) => {
    void handleBrowserAutomationRequest({
      client: options.client,
      getHost,
      request,
      serverId: options.serverId,
      ensureResidentBrowserWebview:
        options.ensureResidentBrowserWebview ?? ensureResidentBrowserWebviewDefault,
      ...(options.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: options.registrationWaitTimeoutMs }
        : {}),
      ...(options.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: options.registrationPollIntervalMs }
        : {}),
    });
  });
  return () => {
    unsubscribe();
  };
}

export function mountBrowserAutomationDaemonClientHandler(
  client: unknown,
  options?: { serverId?: string },
): () => void {
  return mountBrowserAutomationHandler({
    client: client as BrowserAutomationClient,
    ...(options?.serverId ? { serverId: options.serverId } : {}),
  });
}

async function handleBrowserAutomationRequest(params: {
  client: BrowserAutomationHandlerOptions["client"];
  getHost: () => DesktopHostBridge | null;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<void> {
  const {
    client,
    getHost,
    request,
    serverId,
    ensureResidentBrowserWebview,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const browserHost = getHost()?.browser;
  const executeAutomationCommand = browserHost?.executeAutomationCommand;

  if (
    request.command.command === "list_profiles" ||
    request.command.command === "create_profile" ||
    request.command.command === "delete_profile"
  ) {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await handleBrowserProfileRequest({ request, browserHost }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (request.command.command === "new_tab") {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await openBrowserTabForRequest({
          request,
          serverId,
          browserHost,
          ensureResidentBrowserWebview,
          ...(registrationWaitTimeoutMs !== undefined ? { registrationWaitTimeoutMs } : {}),
          ...(registrationPollIntervalMs !== undefined ? { registrationPollIntervalMs } : {}),
        }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (request.command.command === "resize") {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: resizeBrowserTabForRequest({ request, serverId }),
    });
    return;
  }

  if (request.command.command === "close_tab") {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await closeBrowserTabForRequest({
          request,
          serverId,
          browserHost,
        }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeThrownBridgeError(request.requestId, error),
      });
    }
    return;
  }

  if (!executeAutomationCommand) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Browser automation is not available in this app runtime.",
      }),
    });
    return;
  }

  try {
    let payload = await executeAutomationCommand(request);
    if (payload.ok && payload.result.command === "list_tabs" && browserHost?.listProfiles) {
      const profiles = await browserHost.listProfiles();
      const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
      payload = {
        ...payload,
        result: {
          ...payload.result,
          tabs: payload.result.tabs.map((tab) => {
            const profileId = getBrowserRecord(tab.browserId)?.profileId ?? "default";
            const profile = profilesById.get(profileId);
            return {
              ...tab,
              profileId,
              profileName: profile?.name ?? "Default",
            };
          }),
        },
      };
    }
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeBridgePayload(request.requestId, payload),
    });
  } catch (error) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeThrownBridgeError(request.requestId, error),
    });
  }
}

async function handleBrowserProfileRequest(params: {
  request: BrowserAutomationExecuteRequest;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, browserHost } = params;
  const command = request.command;
  if (!browserHost?.listProfiles) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Browser profiles require an updated Paseo desktop host.",
    });
  }
  if (command.command === "list_profiles") {
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "list_profiles", profiles: await browserHost.listProfiles() },
    };
  }
  if (command.command === "create_profile") {
    if (!browserHost.createProfile) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Browser profile creation requires an updated Paseo desktop host.",
      });
    }
    return {
      requestId: request.requestId,
      ok: true,
      result: {
        command: "create_profile",
        profile: await browserHost.createProfile(command.args.name),
      },
    };
  }
  const deleteCommand = command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "delete_profile" }
  >;
  const profiles = await browserHost.listProfiles();
  const profile = profiles.find(
    (candidate) =>
      candidate.id === deleteCommand.args.profile ||
      candidate.name.toLocaleLowerCase() === deleteCommand.args.profile.toLocaleLowerCase(),
  );
  if (!profile || profile.id === "default") {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_denied",
      message: profile
        ? "The Default browser profile cannot be deleted."
        : `Browser profile not found: ${deleteCommand.args.profile}`,
    });
  }
  const deleted = (await browserHost.deleteProfile?.(profile.id)) ?? false;
  if (!deleted) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_denied",
      message: `Browser profile deletion was canceled: ${profile.name}`,
    });
  }
  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "delete_profile", profileId: profile.id },
  };
}

function resizeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
}): BrowserAutomationResponsePayload {
  const { request, serverId } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "resize" }
  >;
  const browserId = command.args.browserId;
  if (!getBrowserRecord(browserId)) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  const workspaceId = request.workspaceId;
  if (serverId && workspaceId && !findWorkspaceBrowserTab({ serverId, workspaceId, browserId })) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  const dimensions = resizeResidentBrowserWebview({
    browserId,
    width: command.args.width,
    height: command.args.height,
  });
  if (!dimensions) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }
  useBrowserStore
    .getState()
    .setBrowserViewport(browserId, createFixedBrowserViewport(dimensions.width, dimensions.height));

  return {
    requestId: request.requestId,
    ok: true,
    result: {
      command: "resize",
      browserId,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

async function closeBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, serverId, browserHost } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "close_tab" }
  >;
  const browserId = command.args.browserId;
  const workspaceId = request.workspaceId;
  const workspaceTab = serverId
    ? findWorkspaceBrowserTab({ serverId, workspaceId, browserId })
    : null;
  if (!workspaceTab && (!serverId || !workspaceId)) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot close a browser tab without a workspace context.",
    });
  }
  if (!workspaceTab || !getBrowserRecord(browserId)) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `No browser tab found for ID: ${browserId}`,
    });
  }

  useWorkspaceLayoutStore.getState().closeTab(workspaceTab.workspaceKey, workspaceTab.tabId);
  useBrowserStore.getState().removeBrowser(browserId);
  removeResidentBrowserWebview(browserId);
  await browserHost?.unregisterWorkspaceBrowser?.(browserId);

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "close_tab", browserId },
  };
}

function findWorkspaceBrowserTab(input: {
  serverId: string;
  workspaceId: string | undefined;
  browserId: string;
}): { workspaceKey: string; tabId: string } | null {
  if (!input.workspaceId) {
    return null;
  }
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) {
    return null;
  }
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const tab = layout
    ? collectAllTabs(layout.root).find((candidate) => {
        return (
          candidate.target.kind === "browser" && candidate.target.browserId === input.browserId
        );
      })
    : null;
  return tab ? { workspaceKey, tabId: tab.tabId } : null;
}

async function openBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<BrowserAutomationResponsePayload> {
  const {
    request,
    serverId,
    browserHost,
    ensureResidentBrowserWebview,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "new_tab" }
  >;
  const workspaceId = request.workspaceId;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }

  const url = command.args.url ?? "https://example.com";
  const profiles = await browserHost?.listProfiles?.();
  const requestedProfile = command.args.profile ?? "Default";
  const profile = profiles?.find(
    (candidate) =>
      candidate.id === requestedProfile ||
      candidate.name.toLocaleLowerCase() === requestedProfile.toLocaleLowerCase(),
  );
  if (command.args.profile && !profile) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_tab_not_found",
      message: `Browser profile not found: ${command.args.profile}`,
    });
  }
  const profileId = profile?.id ?? "default";
  const profileName = profile?.name ?? "Default";
  const { browserId, url: normalizedUrl } = createWorkspaceBrowser({
    initialUrl: url,
    profileId,
  });
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }
  useWorkspaceLayoutStore.getState().openTab({
    workspaceKey,
    target: { kind: "browser", browserId },
    intent: "background",
  });

  if (browserHost?.executeAutomationCommand) {
    ensureResidentBrowserWebview({ browserId, workspaceId, url: normalizedUrl, profileId });
    const registered = await waitForBrowserRegistration({
      request,
      browserId,
      workspaceId,
      executeAutomationCommand: browserHost.executeAutomationCommand,
      ...(registrationWaitTimeoutMs !== undefined ? { timeoutMs: registrationWaitTimeoutMs } : {}),
      ...(registrationPollIntervalMs !== undefined
        ? { pollIntervalMs: registrationPollIntervalMs }
        : {}),
    });
    if (!registered) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_timeout",
        message: `Timed out waiting for browser tab ${browserId} to register with the browser automation host. Try browser_new_tab again.`,
        retryable: true,
      });
    }
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: {
      command: "new_tab",
      browserId,
      workspaceId,
      url: normalizedUrl,
      profileId,
      profileName,
    },
  };
}

async function waitForBrowserRegistration(params: {
  request: BrowserAutomationExecuteRequest;
  browserId: string;
  workspaceId: string;
  executeAutomationCommand: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationResponsePayload>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const payload = await params.executeAutomationCommand({
      type: "browser.automation.execute.request",
      requestId: `${params.request.requestId}:list_tabs`,
      agentId: params.request.agentId,
      cwd: params.request.cwd,
      workspaceId: params.workspaceId,
      command: { command: "list_tabs", args: {} },
    });
    if (payload.ok && payload.result.command === "list_tabs") {
      if (payload.result.tabs.some((tab) => tab.browserId === params.browserId)) {
        return true;
      }
    }
    await delay(params.pollIntervalMs ?? 100);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBridgePayload(
  requestId: string,
  payload: BrowserAutomationResponsePayload,
): BrowserAutomationResponsePayload {
  return { ...payload, requestId } as BrowserAutomationResponsePayload;
}

function normalizeThrownBridgeError(
  requestId: string,
  error: unknown,
): BrowserAutomationFailurePayload {
  const typed = readTypedBrowserAutomationError(error);
  if (typed) {
    return browserAutomationFailure({ requestId, ...typed });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) {
    return browserAutomationFailure({
      requestId,
      code: "browser_unsupported",
      message: "Browser automation is not implemented by this app build yet.",
    });
  }

  return browserAutomationFailure({
    requestId,
    code: "browser_unknown_error",
    message: message || "Browser automation failed.",
  });
}

function readTypedBrowserAutomationError(
  value: unknown,
): { code: BrowserAutomationErrorCode; message: string; retryable?: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !record.code.startsWith("browser_")) {
    return null;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return null;
  }
  return {
    code: record.code as BrowserAutomationErrorCode,
    message: record.message,
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}

function browserAutomationFailure(params: {
  requestId: string;
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserAutomationFailurePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
}
