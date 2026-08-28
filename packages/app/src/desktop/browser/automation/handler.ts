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
import {
  collectAllTabs,
  FOCUSED_PANE_PLACEMENT,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openServiceUrl } from "@/utils/open-service-url";
import { canonicalizeServiceUrl } from "@/utils/service-url-policy";
import { ServiceUrlRequestQueue } from "@/utils/service-url-request-queue";
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
  serviceUrlOpener?: typeof openServiceUrl;
  serviceUrlOperationTimeoutMs?: number;
  serviceUrlQueueLimit?: number;
}

export function mountBrowserAutomationHandler(
  options: BrowserAutomationHandlerOptions,
): () => void {
  const getHost = options.getHost ?? getDesktopHost;
  const serviceUrlQueue = new ServiceUrlRequestQueue<BrowserAutomationResponsePayload>(
    options.serviceUrlOperationTimeoutMs ?? 5 * 60_000,
    options.serviceUrlQueueLimit ?? 10,
  );
  const unsubscribe = options.client.on("browser.automation.execute.request", (request) => {
    const requestOptions = {
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
      serviceUrlOpener: options.serviceUrlOpener ?? openServiceUrl,
      serviceUrlQueue,
    };
    if (request.command.command === "open_service_url") {
      void handleOpenServiceUrlRequest(requestOptions);
      return;
    }
    void handleBrowserAutomationRequest(requestOptions);
  });
  return () => {
    unsubscribe();
    serviceUrlQueue.dispose();
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

// eslint-disable-next-line complexity -- Command routing keeps every bridge response on one audited boundary.
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

  if (
    request.command.command === "list_import_sources" ||
    request.command.command === "import_browser_data"
  ) {
    try {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: await handleBrowserImportRequest({ request, browserHost }),
      });
    } catch (error) {
      client.sendBrowserAutomationExecuteResponse({
        type: "browser.automation.execute.response",
        payload: normalizeBrowserImportError(request.requestId, error),
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
          tabOpen: { intent: "background" },
          waitForRegistration: true,
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

async function handleBrowserImportRequest(params: {
  request: BrowserAutomationExecuteRequest;
  browserHost: DesktopHostBridge["browser"] | undefined;
}): Promise<BrowserAutomationResponsePayload> {
  const { request, browserHost } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "list_import_sources" | "import_browser_data" }
  >;
  if (command.command === "list_import_sources") {
    if (!browserHost?.listImportSources) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Browser data import requires an updated Paseo desktop host.",
      });
    }
    const discovery = await browserHost.listImportSources();
    return {
      requestId: request.requestId,
      ok: true,
      result: { command: "list_import_sources", ...discovery },
    };
  }
  if (!browserHost?.importBrowserData) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unsupported",
      message: "Browser data import requires an updated Paseo desktop host.",
    });
  }
  const result = await browserHost.importBrowserData({
    ...command.args,
    operationId: request.requestId,
  });
  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "import_browser_data", ...result },
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

async function handleOpenServiceUrlRequest(params: {
  client: BrowserAutomationHandlerOptions["client"];
  getHost: () => DesktopHostBridge | null;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
  serviceUrlOpener: typeof openServiceUrl;
  serviceUrlQueue: ServiceUrlRequestQueue<BrowserAutomationResponsePayload>;
}): Promise<void> {
  const command = params.request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "open_service_url" }
  >;
  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeServiceUrl(command.args.url);
  } catch (error) {
    sendServiceUrlFailure(params.client, params.request.requestId, error);
    return;
  }
  const canonicalRequest = {
    ...params.request,
    command: { ...command, args: { ...command.args, url: canonicalUrl } },
  } as BrowserAutomationExecuteRequest;
  const workspaceKey = `${params.serverId ?? "desktop"}:${params.request.workspaceId ?? "no-workspace"}`;
  const queued = params.serviceUrlQueue.enqueue(workspaceKey, (signal) =>
    openServiceUrlForRequest(
      { ...params, request: canonicalRequest, browserHost: params.getHost()?.browser },
      signal,
    ),
  );
  if (!queued) {
    sendServiceUrlFailure(
      params.client,
      params.request.requestId,
      Object.assign(new Error("The Service URL queue is full for this workspace."), {
        code: "browser_denied",
        retryable: true,
      }),
    );
    return;
  }
  if (!command.args.waitForResult) {
    void queued.completion.catch((error: unknown) => {
      console.warn("[browser] Detached Service URL policy open failed after acceptance", {
        requestId: params.request.requestId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    });
    params.client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: {
        requestId: params.request.requestId,
        ok: true,
        result: { command: "open_service_url", url: canonicalUrl, disposition: "accepted" },
      },
    });
    return;
  }
  try {
    params.client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: await queued.completion,
    });
  } catch (error) {
    sendServiceUrlFailure(params.client, params.request.requestId, error);
  }
}

function sendServiceUrlFailure(
  client: BrowserAutomationHandlerOptions["client"],
  requestId: string,
  error: unknown,
): void {
  client.sendBrowserAutomationExecuteResponse({
    type: "browser.automation.execute.response",
    payload: normalizeThrownBridgeError(requestId, error),
  });
}

async function openServiceUrlForRequest(
  params: {
    request: BrowserAutomationExecuteRequest;
    serverId?: string;
    browserHost: DesktopHostBridge["browser"] | undefined;
    ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
    registrationWaitTimeoutMs?: number;
    registrationPollIntervalMs?: number;
    serviceUrlOpener: typeof openServiceUrl;
  },
  signal: AbortSignal,
): Promise<BrowserAutomationResponsePayload> {
  const command = params.request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "open_service_url" }
  >;
  let openedBrowserId: string | undefined;
  let openedWorkspaceId: string | undefined;
  const disposition = await params.serviceUrlOpener(command.args.url, {
    signal,
    openInApp: async (url) => {
      const payload = await openBrowserTabForRequest({
        ...params,
        request: {
          ...params.request,
          command: { command: "new_tab", args: { url } },
        },
        tabOpen: { intent: "reveal", placement: FOCUSED_PANE_PLACEMENT },
        waitForRegistration: false,
      });
      if (!payload.ok) {
        throw Object.assign(new Error(payload.error.message), payload.error);
      }
      if (payload.result.command === "new_tab") {
        openedBrowserId = payload.result.browserId;
        openedWorkspaceId = payload.result.workspaceId;
      }
    },
  });
  return {
    requestId: params.request.requestId,
    ok: true,
    result: {
      command: "open_service_url",
      url: new URL(command.args.url).href,
      disposition,
      ...(openedBrowserId && openedWorkspaceId
        ? { browserId: openedBrowserId, workspaceId: openedWorkspaceId }
        : {}),
    },
  };
}

// eslint-disable-next-line complexity -- Profile selection, pane placement, and registration share one tab-creation transaction.
async function openBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  browserHost: DesktopHostBridge["browser"] | undefined;
  ensureResidentBrowserWebview: typeof ensureResidentBrowserWebviewDefault;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
  tabOpen: { intent: "reveal" | "background"; placement?: typeof FOCUSED_PANE_PLACEMENT };
  waitForRegistration: boolean;
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
  const layoutStore = useWorkspaceLayoutStore.getState();
  const previouslyFocusedPaneId = layoutStore.layoutByWorkspace[workspaceKey]?.focusedPaneId;
  const placement = command.args.placement;
  const tabPlacement =
    placement?.mode === "split"
      ? ({ mode: "pane", paneId: placement.targetPaneId } as const)
      : placement;
  const tabId = layoutStore.openTab({
    workspaceKey,
    target: { kind: "browser", browserId },
    ...params.tabOpen,
    ...(tabPlacement ? { placement: tabPlacement } : {}),
  });
  if (!tabId) {
    useBrowserStore.getState().removeBrowser(browserId);
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_unknown_error",
      message: "Could not place the browser tab in the requested pane.",
    });
  }
  if (placement?.mode === "split") {
    const splitPaneId = layoutStore.splitPane(workspaceKey, {
      tabId,
      targetPaneId: placement.targetPaneId,
      position: placement.position,
    });
    if (!splitPaneId) {
      layoutStore.closeTab(workspaceKey, tabId);
      useBrowserStore.getState().removeBrowser(browserId);
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unknown_error",
        message: "Could not create the requested browser split.",
      });
    }
    if (previouslyFocusedPaneId) {
      layoutStore.focusPane(workspaceKey, previouslyFocusedPaneId);
    }
  }

  const executeAutomationCommand = browserHost?.executeAutomationCommand;
  if (executeAutomationCommand) {
    ensureResidentBrowserWebview({ browserId, workspaceId, url: normalizedUrl, profileId });
    if (params.waitForRegistration) {
      const registered = await waitForBrowserRegistration({
        request,
        browserId,
        workspaceId,
        executeAutomationCommand,
        ...(registrationWaitTimeoutMs !== undefined
          ? { timeoutMs: registrationWaitTimeoutMs }
          : {}),
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

function normalizeBrowserImportError(
  requestId: string,
  error: unknown,
): BrowserAutomationFailurePayload {
  const typed = readTypedBrowserAutomationError(error);
  if (typed) return browserAutomationFailure({ requestId, ...typed });

  const rawMessage = error instanceof Error ? error.message : "";
  const message = rawMessage.replace(
    /^Error invoking remote method 'paseo:browser:(?:import-data|import-sources)': (?:Error: )?/,
    "",
  );
  const safeMessage = [
    "Browser data import was denied",
    "Browser data import confirmation timed out",
    "Browser data import is currently supported",
    "Browser source profile is not available",
    "Browser source profile is no longer available",
    "The complete browser import domain allowlist is too large",
    "The Default browser session is not empty. Retry with explicit merge confirmation.",
    "Import is already running",
    "Invalid browser import",
    "Invalid import",
    "Import categories",
  ].some((prefix) => message.startsWith(prefix))
    ? message
    : "Browser data import failed on the desktop host.";
  return browserAutomationFailure({
    requestId,
    code: "browser_unknown_error",
    message: safeMessage,
  });
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
