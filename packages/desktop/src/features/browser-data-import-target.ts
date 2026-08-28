import type {
  BrowserOriginStorageRecord,
  BrowserStorageImportOutcome,
} from "./browser-data-import.js";

function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export class PendingSessionStorageRestores {
  private readonly recordsByPartitionAndOrigin = new Map<
    string,
    Map<string, BrowserOriginStorageRecord[]>
  >();

  queue(input: {
    partition: string;
    records: BrowserOriginStorageRecord[];
    confirmMerge: boolean;
  }): BrowserStorageImportOutcome {
    if (this.has(input.partition) && !input.confirmMerge) {
      throw new Error("The Default browser session already has a pending sessionStorage restore");
    }
    const byOrigin = this.recordsByPartitionAndOrigin.get(input.partition) ?? new Map();
    for (const record of input.records) {
      byOrigin.set(record.origin, [...(byOrigin.get(record.origin) ?? []), record]);
    }
    if (byOrigin.size > 0) this.recordsByPartitionAndOrigin.set(input.partition, byOrigin);
    return {
      imported: 0,
      queued: input.records.length,
      skipped: 0,
      warnings:
        input.records.length > 0
          ? [
              "sessionStorage is queued by origin for the next matching new tab in the Default browser session.",
            ]
          : [],
    };
  }

  has(partition: string): boolean {
    return (this.recordsByPartitionAndOrigin.get(partition)?.size ?? 0) > 0;
  }

  claim(partition: string, initialUrl: string): BrowserOriginStorageRecord[] {
    const origin = httpOrigin(initialUrl);
    if (!origin) return [];
    const byOrigin = this.recordsByPartitionAndOrigin.get(partition);
    const records = byOrigin?.get(origin) ?? [];
    if (!byOrigin || records.length === 0) return [];
    byOrigin.delete(origin);
    if (byOrigin.size === 0) this.recordsByPartitionAndOrigin.delete(partition);
    return records;
  }

  restore(partition: string, records: BrowserOriginStorageRecord[]): void {
    if (records.length === 0) return;
    const byOrigin = this.recordsByPartitionAndOrigin.get(partition) ?? new Map();
    for (const record of records) {
      byOrigin.set(record.origin, [...(byOrigin.get(record.origin) ?? []), record]);
    }
    this.recordsByPartitionAndOrigin.set(partition, byOrigin);
  }
}

const SESSION_STORAGE_RESTORE_WORLD = "paseo-browser-import";

export function buildSessionStorageRestoreScript(records: BrowserOriginStorageRecord[]): string {
  const origin = records[0]?.origin ?? "";
  const values = records.map(({ key, value }) => ({ key, value }));
  return `(() => {
    if (globalThis.__paseoSessionStorageRestoreApplied || location.origin !== ${JSON.stringify(origin)}) return;
    globalThis.__paseoSessionStorageRestoreApplied = true;
    const records = ${JSON.stringify(values)};
    for (const record of records) {
      try {
        sessionStorage.setItem(record.key, record.value);
      } catch {}
    }
  })();`;
}

export interface BrowserImportDebugger {
  attach(protocolVersion: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
  on(
    event: "message",
    listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
  ): void;
  removeListener(
    event: "message",
    listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
  ): void;
}

export interface SessionStorageRestoreContents {
  debugger: BrowserImportDebugger;
  loadURL(url: string): Promise<void>;
  navigationHistory: { clear(): void };
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

export interface SessionStorageRestoreResult {
  imported: number;
  unapplied: BrowserOriginStorageRecord[];
}

export class SessionStorageRestoreError extends Error {
  readonly unapplied: BrowserOriginStorageRecord[];

  constructor(message: string, unapplied: BrowserOriginStorageRecord[]) {
    super(message);
    this.name = "SessionStorageRestoreError";
    this.unapplied = unapplied;
  }
}

async function writeLocalStorageWithAttachedDebugger(
  targetDebugger: BrowserImportDebugger,
  records: BrowserOriginStorageRecord[],
  signal?: AbortSignal,
): Promise<BrowserStorageImportOutcome> {
  const failed = new Set<BrowserOriginStorageRecord>();
  await targetDebugger.sendCommand("DOMStorage.enable");
  for (const record of records) {
    signal?.throwIfAborted();
    try {
      await targetDebugger.sendCommand("DOMStorage.setDOMStorageItem", {
        storageId: { securityOrigin: record.origin, isLocalStorage: true },
        key: record.key,
        value: record.value,
      });
    } catch {
      failed.add(record);
    }
  }

  let imported = 0;
  for (const origin of new Set(records.map((record) => record.origin))) {
    signal?.throwIfAborted();
    const response = (await targetDebugger.sendCommand("DOMStorage.getDOMStorageItems", {
      storageId: { securityOrigin: origin, isLocalStorage: true },
    })) as { entries?: unknown };
    const actual = new Map(
      Array.isArray(response.entries)
        ? response.entries.filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string",
          )
        : [],
    );
    for (const record of records) {
      if (
        !failed.has(record) &&
        record.origin === origin &&
        actual.get(record.key) === record.value
      ) {
        imported += 1;
      } else if (record.origin === origin) {
        failed.add(record);
      }
    }
  }
  return { imported, skipped: failed.size };
}

const INERT_DOCUMENT = "<!doctype html><meta charset=utf-8>";
const INERT_DOCUMENT_HEADERS = [
  { name: "content-type", value: "text/html; charset=utf-8" },
  { name: "content-security-policy", value: "default-src 'none'" },
];

export async function injectLocalStorageWithInertOrigins(
  contents: SessionStorageRestoreContents,
  records: BrowserOriginStorageRecord[],
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<BrowserStorageImportOutcome> {
  signal?.throwIfAborted();
  const recordsByOrigin = new Map<string, BrowserOriginStorageRecord[]>();
  for (const record of records) {
    const originRecords = recordsByOrigin.get(record.origin) ?? [];
    originRecords.push(record);
    recordsByOrigin.set(record.origin, originRecords);
  }
  const bootstrapUrls = new Map(
    [...recordsByOrigin].map(([origin]) => [
      `${origin}/.well-known/paseo-browser-import/${crypto.randomUUID()}`,
      origin,
    ]),
  );
  let rejectFailure: ((error: Error) => void) | null = null;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const timeoutId = setTimeout(
    () => rejectFailure?.(new Error("Timed out importing localStorage")),
    timeoutMs,
  );
  const onDestroyed = () => rejectFailure?.(new Error("Browser tab was destroyed during import"));
  const onAbort = () => rejectFailure?.(signal?.reason ?? new Error("Browser import cancelled"));
  const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method !== "Fetch.requestPaused") return undefined;
    const request = params.request as { url?: unknown } | undefined;
    if (typeof params.requestId !== "string" || typeof request?.url !== "string") {
      return undefined;
    }
    const command = bootstrapUrls.has(request.url)
      ? contents.debugger.sendCommand("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: INERT_DOCUMENT_HEADERS,
          body: Buffer.from(INERT_DOCUMENT).toString("base64"),
        })
      : contents.debugger.sendCommand("Fetch.continueRequest", { requestId: params.requestId });
    void command.catch((error) =>
      rejectFailure?.(error instanceof Error ? error : new Error("Fetch interception failed")),
    );
    return undefined;
  };

  contents.once("destroyed", onDestroyed);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([contents.loadURL("about:blank"), failure]);
    contents.navigationHistory.clear();
    contents.debugger.attach("1.3");
    contents.debugger.on("message", onMessage);
    await Promise.race([
      contents.debugger.sendCommand("Fetch.enable", {
        patterns: [...bootstrapUrls.keys()].map((urlPattern) => ({ urlPattern })),
      }),
      failure,
    ]);
    let imported = 0;
    let skipped = 0;
    for (const [bootstrapUrl, origin] of bootstrapUrls) {
      signal?.throwIfAborted();
      await Promise.race([contents.loadURL(bootstrapUrl), failure]);
      const outcome = await Promise.race([
        writeLocalStorageWithAttachedDebugger(
          contents.debugger,
          recordsByOrigin.get(origin) ?? [],
          signal,
        ),
        failure,
      ]);
      imported += outcome.imported;
      skipped += outcome.skipped;
    }
    return { imported, skipped };
  } finally {
    contents.removeListener("destroyed", onDestroyed);
    signal?.removeEventListener("abort", onAbort);
    contents.debugger.removeListener("message", onMessage);
    if (contents.debugger.isAttached()) {
      await Promise.race([contents.debugger.sendCommand("Fetch.disable"), failure]).catch(
        () => undefined,
      );
      contents.debugger.detach();
    }
    clearTimeout(timeoutId);
  }
}

export async function installSessionStorageRestore(
  contents: SessionStorageRestoreContents,
  records: BrowserOriginStorageRecord[],
  initialUrl: string,
  bindingTimeoutMs = 5_000,
): Promise<SessionStorageRestoreResult> {
  const expectedOrigin = httpOrigin(initialUrl);
  if (!expectedOrigin || records.some((record) => record.origin !== expectedOrigin)) {
    throw new SessionStorageRestoreError("Invalid sessionStorage restore origin", records);
  }

  let appliedIndexes = new Set<number>();
  contents.debugger.attach("1.3");
  let rejectDestroyed: ((error: Error) => void) | null = null;
  const destroyed = new Promise<never>((_resolve, reject) => {
    rejectDestroyed = reject;
  });
  const onDestroyed = () =>
    rejectDestroyed?.(new Error("Browser tab was destroyed during restore"));
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Timed out waiting for sessionStorage restore")),
      bindingTimeoutMs,
    );
  });
  const fail = Promise.race([destroyed, timedOut]);

  contents.once("destroyed", onDestroyed);
  let identifier: string | null = null;
  try {
    if (contents.isDestroyed()) throw new Error("Browser tab was destroyed before restore");
    await Promise.race([contents.loadURL("about:blank"), fail]);
    contents.navigationHistory.clear();
    await Promise.race([contents.debugger.sendCommand("Page.enable"), fail]);
    await Promise.race([contents.debugger.sendCommand("DOMStorage.enable"), fail]);
    // Install the restore before loadURL so the page cannot read sessionStorage during an earlier script.
    const installed = (await Promise.race([
      contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: buildSessionStorageRestoreScript(records),
        worldName: SESSION_STORAGE_RESTORE_WORLD,
      }),
      fail,
    ])) as { identifier?: unknown };
    if (typeof installed.identifier !== "string") {
      throw new Error("Electron did not return a sessionStorage restore script identifier");
    }
    identifier = installed.identifier;
    await Promise.race([contents.loadURL(initialUrl), fail]);
    contents.navigationHistory.clear();
    const response = (await Promise.race([
      contents.debugger.sendCommand("DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin: expectedOrigin, isLocalStorage: false },
      }),
      fail,
    ])) as { entries?: unknown };
    const actual = new Map(
      Array.isArray(response.entries)
        ? response.entries.filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string",
          )
        : [],
    );
    appliedIndexes = new Set(
      records.flatMap((record, index) => (actual.get(record.key) === record.value ? [index] : [])),
    );
    const unapplied = records.filter((_record, index) => !appliedIndexes.has(index));
    return { imported: records.length - unapplied.length, unapplied };
  } catch (error) {
    const unapplied = records.filter((_record, index) => !appliedIndexes.has(index));
    throw new SessionStorageRestoreError(
      error instanceof Error ? error.message : "sessionStorage restore failed",
      unapplied,
    );
  } finally {
    contents.removeListener("destroyed", onDestroyed);
    if (identifier && contents.debugger.isAttached()) {
      await Promise.race([
        contents.debugger.sendCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier }),
        fail,
      ]).catch(() => undefined);
    }
    if (contents.debugger.isAttached()) contents.debugger.detach();
    if (timeoutId) clearTimeout(timeoutId);
  }
}
