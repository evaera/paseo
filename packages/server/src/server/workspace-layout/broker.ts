import { randomUUID } from "node:crypto";
import {
  WorkspaceLayoutExecuteRequestSchema,
  WorkspaceLayoutExecuteResponseSchema,
  type WorkspaceLayoutCommand,
  type WorkspaceLayoutExecuteRequest,
  type WorkspaceLayoutExecuteResponse,
} from "@getpaseo/protocol/workspace-layout/rpc-schemas";

export type WorkspaceLayoutResponsePayload = WorkspaceLayoutExecuteResponse["payload"];

export interface WorkspaceLayoutHostClient {
  clientId: string;
  hostInstanceId: string;
  hostKind: string;
  sendWorkspaceLayoutRequest(request: WorkspaceLayoutExecuteRequest): void | Promise<void>;
}

interface RegisteredHost {
  client: WorkspaceLayoutHostClient;
  sequence: number;
}

interface PendingRequest {
  clientId: string;
  hostInstanceId: string;
  externalRequestId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: WorkspaceLayoutResponsePayload) => void;
}

export class WorkspaceLayoutBroker {
  private readonly clients = new Map<string, RegisteredHost>();
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  public constructor(
    private readonly options: { defaultTimeoutMs?: number; createRequestId?: () => string } = {},
  ) {}

  public registerClient(client: WorkspaceLayoutHostClient): () => void {
    this.unregisterClient(client.hostInstanceId);
    const sequence = ++this.sequence;
    this.clients.set(client.hostInstanceId, { client, sequence });
    return () => {
      const current = this.clients.get(client.hostInstanceId);
      if (current?.sequence === sequence) this.unregisterClient(client.hostInstanceId);
    };
  }

  public unregisterClient(hostInstanceId: string): void {
    if (!this.clients.delete(hostInstanceId)) return;
    for (const [internalRequestId, pending] of this.pending) {
      if (pending.hostInstanceId !== hostInstanceId) continue;
      this.pending.delete(internalRequestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        failure(
          pending.externalRequestId,
          "layout_no_host",
          "The workspace layout host disconnected.",
          true,
          hostInstanceId,
        ),
      );
    }
  }

  public async execute(input: {
    workspaceId: string;
    command: WorkspaceLayoutCommand;
    agentId?: string;
    hostInstanceId?: string;
    requestId?: string;
    timeoutMs?: number;
  }): Promise<WorkspaceLayoutResponsePayload> {
    const internalRequestId = this.options.createRequestId?.() ?? `layout_route_${randomUUID()}`;
    const externalRequestId = input.requestId ?? internalRequestId;
    const host = this.selectHost(input.hostInstanceId, externalRequestId);
    if (!host.ok) return host.payload;
    const parsed = WorkspaceLayoutExecuteRequestSchema.safeParse({
      type: "workspace.layout.execute.request",
      requestId: internalRequestId,
      workspaceId: input.workspaceId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      hostInstanceId: host.value.client.hostInstanceId,
      command: input.command,
    });
    if (!parsed.success) {
      return failure(
        externalRequestId,
        "layout_invalid_operation",
        parsed.error.issues[0]?.message ?? "Invalid layout command.",
      );
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => {
          this.pending.delete(internalRequestId);
          resolve(
            failure(
              externalRequestId,
              "layout_timeout",
              "Timed out waiting for the workspace layout host.",
              true,
              host.value.client.hostInstanceId,
            ),
          );
        },
        input.timeoutMs ?? this.options.defaultTimeoutMs ?? 15_000,
      );
      this.pending.set(internalRequestId, {
        clientId: host.value.client.clientId,
        hostInstanceId: host.value.client.hostInstanceId,
        externalRequestId,
        timeout,
        resolve,
      });
      Promise.resolve(host.value.client.sendWorkspaceLayoutRequest(parsed.data)).catch(
        (error: unknown) => {
          const pending = this.pending.get(internalRequestId);
          if (!pending) return;
          this.pending.delete(internalRequestId);
          clearTimeout(pending.timeout);
          pending.resolve(
            failure(
              externalRequestId,
              "layout_unknown_error",
              error instanceof Error ? error.message : String(error),
              false,
              pending.hostInstanceId,
            ),
          );
        },
      );
    });
  }

  public receiveResponse(
    response: WorkspaceLayoutExecuteResponse,
    sender: { clientId: string; hostInstanceId: string },
  ): boolean {
    const parsed = WorkspaceLayoutExecuteResponseSchema.safeParse(response);
    if (!parsed.success) return false;
    const pending = this.pending.get(parsed.data.payload.requestId);
    if (
      !pending ||
      pending.clientId !== sender.clientId ||
      pending.hostInstanceId !== sender.hostInstanceId ||
      parsed.data.payload.hostInstanceId !== sender.hostInstanceId
    ) {
      return false;
    }
    this.pending.delete(parsed.data.payload.requestId);
    clearTimeout(pending.timeout);
    pending.resolve({ ...parsed.data.payload, requestId: pending.externalRequestId });
    return true;
  }

  private selectHost(
    requestedHostInstanceId: string | undefined,
    requestId: string,
  ): { ok: true; value: RegisteredHost } | { ok: false; payload: WorkspaceLayoutResponsePayload } {
    if (requestedHostInstanceId) {
      const host = this.clients.get(requestedHostInstanceId);
      return host
        ? { ok: true, value: host }
        : {
            ok: false,
            payload: failure(
              requestId,
              "layout_no_host",
              `No connected layout host has instance ID ${requestedHostInstanceId}.`,
              true,
            ),
          };
    }
    const hosts = [...this.clients.values()];
    if (hosts.length === 0) {
      return {
        ok: false,
        payload: failure(
          requestId,
          "layout_no_host",
          "No connected app can manage workspace layouts.",
          true,
        ),
      };
    }
    if (hosts.length > 1) {
      const ids = hosts
        .map(({ client }) => client.hostInstanceId)
        .sort()
        .join(", ");
      return {
        ok: false,
        payload: failure(
          requestId,
          "layout_ambiguous_host",
          `Multiple workspace layout hosts are connected. Choose hostInstanceId: ${ids}.`,
        ),
      };
    }
    return { ok: true, value: hosts[0]! };
  }
}

function failure(
  requestId: string,
  code: Extract<WorkspaceLayoutResponsePayload, { ok: false }>["error"]["code"],
  message: string,
  retryable = false,
  hostInstanceId?: string,
): WorkspaceLayoutResponsePayload {
  return {
    status: "error",
    requestId,
    ok: false,
    ...(hostInstanceId ? { hostInstanceId } : {}),
    error: { code, message, retryable },
  };
}
