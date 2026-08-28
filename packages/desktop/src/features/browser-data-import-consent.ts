import { normalizeBrowserImportRequest, type BrowserImportRequest } from "./browser-data-import.js";

const DEFAULT_CONSENT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_CONSENT_DOMAIN_DISPLAY_LENGTH = 1_000;

export function formatBrowserImportConsentDetail(input: {
  sourceName: string;
  profileName: string;
  request: BrowserImportRequest;
}): string {
  const domains = input.request.domains.join(", ");
  if (domains.length > MAX_CONSENT_DOMAIN_DISPLAY_LENGTH) {
    throw new Error("The complete browser import domain allowlist is too large to display safely");
  }
  return `Source: ${input.sourceName} / ${input.profileName}\nDestination: Default browser session\nDomains: ${domains}\nData: ${input.request.categories.join(", ")}\nMerge into existing data: ${input.request.confirmMerge ? "Yes" : "No"}`;
}

interface BrowserDataImportConsentQueueOptions<Event, Result> {
  confirm: (event: Event, request: BrowserImportRequest, signal: AbortSignal) => Promise<void>;
  importData: (
    event: Event,
    request: BrowserImportRequest,
    rawRequest: unknown,
    signal: AbortSignal,
  ) => Promise<Result>;
  consentTimeoutMs?: number;
}

function readOperationId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const operationId = (value as Record<string, unknown>).operationId;
  if (operationId === undefined) return undefined;
  if (
    typeof operationId !== "string" ||
    operationId.length < 1 ||
    operationId.length > 160 ||
    // eslint-disable-next-line no-control-regex -- Operation IDs must reject ASCII control characters before IPC use.
    /[\u0000-\u001f\u007f]/.test(operationId)
  ) {
    throw new Error("Invalid browser import operation id");
  }
  return operationId;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function raceWithAbort<Result>(promise: Promise<Result>, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    function onAbort() {
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        return resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        return reject(error);
      },
    );
  });
}

export class BrowserDataImportConsentQueue<Event, Result> {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Map<string, AbortController>();
  private readonly controllersByEvent = new Map<Event, Set<AbortController>>();

  public constructor(
    private readonly options: BrowserDataImportConsentQueueOptions<Event, Result>,
  ) {}

  public async run(event: Event, rawRequest: unknown): Promise<Result> {
    const request = normalizeBrowserImportRequest(rawRequest);
    const operationId = readOperationId(rawRequest);
    const controller = new AbortController();
    if (operationId && this.controllers.has(operationId)) {
      throw new Error("Import is already running");
    }
    const eventControllers = this.controllersByEvent.get(event) ?? new Set<AbortController>();
    eventControllers.add(controller);
    this.controllersByEvent.set(event, eventControllers);
    if (operationId) this.controllers.set(operationId, controller);

    const previous = this.tail;
    let release = () => {};
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = previous.catch(() => undefined).then(() => completed);

    try {
      await raceWithAbort(
        previous.catch(() => undefined),
        controller.signal,
      );
      const timeout = setTimeout(() => {
        controller.abort(new Error("Browser data import confirmation timed out"));
      }, this.options.consentTimeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS);
      try {
        await raceWithAbort(
          this.options.confirm(event, request, controller.signal),
          controller.signal,
        );
      } finally {
        clearTimeout(timeout);
      }
      controller.signal.throwIfAborted();
      return await this.options.importData(event, request, rawRequest, controller.signal);
    } finally {
      release();
      if (operationId && this.controllers.get(operationId) === controller) {
        this.controllers.delete(operationId);
      }
      eventControllers.delete(controller);
      if (eventControllers.size === 0) this.controllersByEvent.delete(event);
    }
  }

  public cancelForEvent(event: Event): boolean {
    const controllers = this.controllersByEvent.get(event);
    if (!controllers) return false;
    for (const controller of controllers) controller.abort();
    return true;
  }

  public cancel(operationId: string): boolean {
    const controller = this.controllers.get(operationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
}
