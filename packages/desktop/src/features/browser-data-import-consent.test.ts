import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserImportRequest } from "./browser-data-import.js";
import {
  BrowserDataImportConsentQueue,
  formatBrowserImportConsentDetail,
} from "./browser-data-import-consent.js";

const REQUEST = {
  sourceBrowserId: "chrome",
  sourceProfileId: "Default",
  domains: ["example.com"],
  categories: ["cookies"],
  confirmMerge: false,
} satisfies BrowserImportRequest;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
}

function deferred<Value = void>(): Deferred<Value> {
  let resolve = (_value: Value | PromiseLike<Value>) => {};
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function requestWithOperationId(operationId: string) {
  return { ...REQUEST, operationId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("browser data import consent display", () => {
  test("renders the complete allowlist within the visible bound", () => {
    expect(
      formatBrowserImportConsentDetail({
        sourceName: "Google Chrome",
        profileName: "Default",
        request: REQUEST,
      }),
    ).toContain("Domains: example.com");
  });

  test("fails closed when the complete allowlist exceeds the visible bound", () => {
    expect(() =>
      formatBrowserImportConsentDetail({
        sourceName: "Google Chrome",
        profileName: "Default",
        request: { ...REQUEST, domains: ["a".repeat(1_001)] },
      }),
    ).toThrow("The complete browser import domain allowlist is too large to display safely");
  });
});

describe("browser data import consent queue", () => {
  test("requires confirmation before every import", async () => {
    const events: string[] = [];
    const queue = new BrowserDataImportConsentQueue<string, string>({
      confirm: async (source, request) => {
        events.push(`confirm:${source}:${request.sourceBrowserId}`);
      },
      importData: async (source) => {
        events.push(`import:${source}`);
        return source;
      },
    });

    await expect(queue.run("ui", REQUEST)).resolves.toBe("ui");
    await expect(queue.run("agent", REQUEST)).resolves.toBe("agent");

    expect(events).toEqual([
      "confirm:ui:chrome",
      "import:ui",
      "confirm:agent:chrome",
      "import:agent",
    ]);
  });

  test("serializes concurrent UI and agent imports through confirmation and source reading", async () => {
    const events: string[] = [];
    const uiImportStarted = deferred();
    const uiImportBlocked = deferred();
    const queue = new BrowserDataImportConsentQueue<string, string>({
      confirm: async (source) => {
        events.push(`confirm:${source}`);
      },
      importData: async (source, _request: BrowserImportRequest) => {
        events.push(`import:start:${source}`);
        if (source === "ui") {
          uiImportStarted.resolve();
          await uiImportBlocked.promise;
        }
        events.push(`import:end:${source}`);
        return source;
      },
    });

    const ui = queue.run("ui", REQUEST);
    const agent = queue.run("agent", REQUEST);
    await uiImportStarted.promise;

    expect(events).toEqual(["confirm:ui", "import:start:ui"]);
    uiImportBlocked.resolve();
    await expect(Promise.all([ui, agent])).resolves.toEqual(["ui", "agent"]);
    expect(events).toEqual([
      "confirm:ui",
      "import:start:ui",
      "import:end:ui",
      "confirm:agent",
      "import:start:agent",
      "import:end:agent",
    ]);
  });

  test("does not read source data after consent is denied", async () => {
    let imports = 0;
    const queue = new BrowserDataImportConsentQueue<string, void>({
      confirm: async () => {
        throw new Error("denied");
      },
      importData: async () => {
        imports += 1;
      },
    });

    await expect(queue.run("ui", REQUEST)).rejects.toThrow("denied");
    expect(imports).toBe(0);
  });

  test("cancels an operation while it is queued", async () => {
    const events: string[] = [];
    const firstImportStarted = deferred();
    const releaseFirstImport = deferred();
    const queue = new BrowserDataImportConsentQueue<string, string>({
      confirm: async (source) => {
        events.push(`confirm:${source}`);
      },
      importData: async (source) => {
        events.push(`import:${source}`);
        if (source === "first") {
          firstImportStarted.resolve();
          await releaseFirstImport.promise;
        }
        return source;
      },
    });

    const first = queue.run("first", REQUEST);
    await firstImportStarted.promise;
    const queued = queue.run("queued", requestWithOperationId("queued-import"));

    expect(queue.cancel("queued-import")).toBe(true);
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["confirm:first", "import:first"]);

    releaseFirstImport.resolve();
    await expect(first).resolves.toBe("first");
  });

  test("cancels an operation while consent is pending", async () => {
    const confirmationStarted = deferred();
    const staleConfirmation = deferred();
    let imports = 0;
    const queue = new BrowserDataImportConsentQueue<string, void>({
      confirm: async () => {
        confirmationStarted.resolve();
        await staleConfirmation.promise;
      },
      importData: async () => {
        imports += 1;
      },
    });

    const pending = queue.run("ui", requestWithOperationId("pending-consent"));
    await confirmationStarted.promise;

    expect(queue.cancel("pending-consent")).toBe(true);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(imports).toBe(0);

    staleConfirmation.resolve();
    await Promise.resolve();
    expect(imports).toBe(0);
  });

  test("rejects a duplicate operation id before opening another consent prompt", async () => {
    const confirmationStarted = deferred();
    const staleConfirmation = deferred();
    let confirmations = 0;
    const queue = new BrowserDataImportConsentQueue<string, void>({
      confirm: async () => {
        confirmations += 1;
        confirmationStarted.resolve();
        await staleConfirmation.promise;
      },
      importData: async () => {},
    });

    const first = queue.run("first", requestWithOperationId("duplicate"));
    await confirmationStarted.promise;

    await expect(queue.run("second", requestWithOperationId("duplicate"))).rejects.toThrow(
      "Import is already running",
    );
    expect(confirmations).toBe(1);

    expect(queue.cancel("duplicate")).toBe(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    staleConfirmation.resolve();
  });

  test("releases the queue when consent times out", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const stalledConfirmation = deferred();
    const queue = new BrowserDataImportConsentQueue<string, string>({
      consentTimeoutMs: 1_000,
      confirm: async (source) => {
        events.push(`confirm:${source}`);
        if (source === "stalled") await stalledConfirmation.promise;
      },
      importData: async (source) => {
        events.push(`import:${source}`);
        return source;
      },
    });

    const stalled = queue.run("stalled", requestWithOperationId("stalled"));
    const stalledRejected = expect(stalled).rejects.toThrow(
      "Browser data import confirmation timed out",
    );
    const next = queue.run("next", requestWithOperationId("next"));
    await vi.advanceTimersByTimeAsync(1_000);

    await stalledRejected;
    await expect(next).resolves.toBe("next");
    expect(events).toEqual(["confirm:stalled", "confirm:next", "import:next"]);
  });

  test("ignores a stale consent answer after timeout", async () => {
    vi.useFakeTimers();
    const staleConfirmation = deferred();
    const imports: string[] = [];
    const queue = new BrowserDataImportConsentQueue<string, string>({
      consentTimeoutMs: 1_000,
      confirm: async (source) => {
        if (source === "stale") await staleConfirmation.promise;
      },
      importData: async (source) => {
        imports.push(source);
        return source;
      },
    });

    const stale = queue.run("stale", requestWithOperationId("stale"));
    const staleRejected = expect(stale).rejects.toThrow(
      "Browser data import confirmation timed out",
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await staleRejected;

    staleConfirmation.resolve();
    await Promise.resolve();
    expect(imports).toEqual([]);
  });
});
