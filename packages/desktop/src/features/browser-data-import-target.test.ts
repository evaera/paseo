import vm from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildSessionStorageRestoreScript,
  injectLocalStorageWithInertOrigins,
  installSessionStorageRestore,
  PendingSessionStorageRestores,
  SessionStorageRestoreError,
} from "./browser-data-import-target.js";

const RECORDS = [
  { origin: "https://example.com", key: "token", value: "session-secret" },
  { origin: "https://other.test", key: "other", value: "other-secret" },
];

function createRestoreContents(options?: {
  acknowledge?: number[];
  hangVerification?: boolean;
  loadError?: Error;
}) {
  const calls: string[] = [];
  let attached = false;
  let destroyedListener: (() => void) | null = null;
  let messageListener:
    | ((event: unknown, method: string, params: Record<string, unknown>) => void)
    | null = null;
  const contents = {
    debugger: {
      attach: () => {
        calls.push("attach");
        attached = true;
      },
      detach: () => {
        calls.push("detach");
        attached = false;
      },
      isAttached: () => attached,
      sendCommand: async (method: string) => {
        calls.push(method);
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
        if (method === "DOMStorage.getDOMStorageItems") {
          if (options?.hangVerification) return new Promise(() => {});
          return {
            entries: options?.acknowledge?.includes(0) ? [[RECORDS[0].key, RECORDS[0].value]] : [],
          };
        }
        return {};
      },
      on: (_event: "message", listener: typeof messageListener) => {
        messageListener = listener;
      },
      removeListener: () => {
        messageListener = null;
      },
    },
    loadURL: async (url: string) => {
      calls.push(`loadURL:${url}`);
      if (url === "about:blank") return;
      if (options?.loadError) throw options.loadError;
      if (options?.acknowledge) {
        messageListener?.({}, "Runtime.bindingCalled", {
          name: "__paseoSessionStorageRestored",
          payload: JSON.stringify({
            origin: "https://example.com",
            applied: options.acknowledge,
          }),
        });
      }
    },
    navigationHistory: { clear: () => calls.push("clearHistory") },
    isDestroyed: () => false,
    once: (_event: "destroyed", listener: () => void) => {
      destroyedListener = listener;
    },
    removeListener: () => {
      destroyedListener = null;
    },
  };
  return {
    calls,
    contents,
    destroy: () => destroyedListener?.(),
    isAttached: () => attached,
  };
}

describe("pending sessionStorage restores", () => {
  test("queues by profile and origin and only claims a matching HTTP(S) initial URL", () => {
    const pending = new PendingSessionStorageRestores();
    const outcome = pending.queue({
      partition: "persist:target",
      records: RECORDS,
      confirmMerge: false,
    });

    expect(outcome).toMatchObject({ imported: 0, queued: 2, skipped: 0 });
    expect(pending.claim("persist:target", "")).toEqual([]);
    expect(pending.claim("persist:target", "about:blank")).toEqual([]);
    expect(pending.claim("persist:target", "https://unmatched.test/path")).toEqual([]);
    expect(pending.claim("persist:other", "https://example.com")).toEqual([]);
    expect(pending.claim("persist:target", "https://example.com/path")).toEqual([RECORDS[0]]);
    expect(pending.has("persist:target")).toBe(true);
    expect(pending.claim("persist:target", "https://other.test/next")).toEqual([RECORDS[1]]);
    expect(pending.has("persist:target")).toBe(false);
  });

  test("clears all queued restores for a profile", () => {
    const pending = new PendingSessionStorageRestores();
    pending.queue({ partition: "persist:target", records: RECORDS, confirmMerge: false });

    pending.clear("persist:target");

    expect(pending.has("persist:target")).toBe(false);
    expect(pending.claim("persist:target", "https://example.com")).toEqual([]);
  });

  test("requires merge confirmation when a target already has a pending restore", () => {
    const pending = new PendingSessionStorageRestores();
    pending.queue({ partition: "persist:target", records: RECORDS, confirmMerge: false });

    expect(() =>
      pending.queue({ partition: "persist:target", records: RECORDS, confirmMerge: false }),
    ).toThrow("pending sessionStorage restore");
  });

  test("bootstraps localStorage through target-scoped inert Fetch interception", async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const stored = new Map<string, string>();
    let attached = false;
    let messageListener:
      | ((event: unknown, method: string, params: Record<string, unknown>) => void)
      | null = null;
    const contents = {
      debugger: {
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        isAttached: () => attached,
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          calls.push({ method, params });
          if (method === "DOMStorage.setDOMStorageItem") {
            stored.set(params?.key as string, params?.value as string);
          }
          if (method === "DOMStorage.getDOMStorageItems") return { entries: [...stored] };
          return {};
        },
        on: (_event: "message", listener: typeof messageListener) => {
          messageListener = listener;
        },
        removeListener: () => {
          messageListener = null;
        },
      },
      loadURL: async (url: string) => {
        if (url !== "about:blank") {
          messageListener?.({}, "Fetch.requestPaused", {
            requestId: "request-1",
            request: { url },
          });
        }
      },
      navigationHistory: { clear: () => {} },
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
    };

    await expect(
      injectLocalStorageWithInertOrigins(contents, [RECORDS[0]], undefined, 50),
    ).resolves.toEqual({ imported: 1, skipped: 0 });

    const fulfill = calls.find((call) => call.method === "Fetch.fulfillRequest");
    expect(fulfill?.params).toMatchObject({
      requestId: "request-1",
      responseCode: 200,
      responseHeaders: [
        { name: "content-type", value: "text/html; charset=utf-8" },
        { name: "content-security-policy", value: "default-src 'none'" },
      ],
    });
    expect(calls.map((call) => call.method)).toContain("Fetch.disable");
    expect(attached).toBe(false);
  });

  test("fails closed when localStorage bootstrap attempts another network request", async () => {
    let attached = false;
    let messageListener:
      | ((event: unknown, method: string, params: Record<string, unknown>) => void)
      | null = null;
    const contents = {
      debugger: {
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
        },
        isAttached: () => attached,
        sendCommand: async () => ({}),
        on: (_event: "message", listener: typeof messageListener) => {
          messageListener = listener;
        },
        removeListener: () => {
          messageListener = null;
        },
      },
      loadURL: async (url: string) => {
        if (url !== "about:blank") {
          messageListener?.({}, "Fetch.requestPaused", {
            requestId: "unexpected",
            request: { url: "https://tracker.invalid/pixel" },
          });
        }
      },
      navigationHistory: { clear: () => {} },
      isDestroyed: () => false,
      once: () => {},
      removeListener: () => {},
    };

    await expect(
      injectLocalStorageWithInertOrigins(contents, [RECORDS[0]], undefined, 50),
    ).rejects.toThrow("Unexpected network request");
    expect(attached).toBe(false);
  });

  test("cleans up the script, listener, and debugger after application", async () => {
    const fixture = createRestoreContents({ acknowledge: [0] });
    const records = [RECORDS[0]];

    await expect(
      installSessionStorageRestore(fixture.contents, records, "https://example.com/path"),
    ).resolves.toEqual({ imported: 1, unapplied: [] });

    expect(fixture.calls).toEqual([
      "attach",
      "loadURL:about:blank",
      "clearHistory",
      "Page.enable",
      "DOMStorage.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "loadURL:https://example.com/path",
      "clearHistory",
      "DOMStorage.getDOMStorageItems",
      "Page.removeScriptToEvaluateOnNewDocument",
      "detach",
    ]);
    expect(fixture.isAttached()).toBe(false);
  });

  test("reports partial applications so only unapplied records are requeued", async () => {
    const records = [RECORDS[0], { origin: "https://example.com", key: "second", value: "value" }];
    const fixture = createRestoreContents({ acknowledge: [0] });

    await expect(
      installSessionStorageRestore(fixture.contents, records, "https://example.com", 50),
    ).resolves.toEqual({ imported: 1, unapplied: [records[1]] });
  });

  test("cleans up and returns all unapplied records on navigation failure", async () => {
    const fixture = createRestoreContents({ loadError: new Error("navigation failed") });

    const error = await installSessionStorageRestore(
      fixture.contents,
      [RECORDS[0]],
      "https://example.com",
      50,
    ).catch((cause) => cause);

    expect(error).toBeInstanceOf(SessionStorageRestoreError);
    expect(error.unapplied).toEqual([RECORDS[0]]);
    expect(fixture.calls).toContain("Page.removeScriptToEvaluateOnNewDocument");
    expect(fixture.isAttached()).toBe(false);
  });

  test("fails a destroyed tab race and requeues unapplied records", async () => {
    const fixture = createRestoreContents({ hangVerification: true });
    const restoring = installSessionStorageRestore(
      fixture.contents,
      [RECORDS[0]],
      "https://example.com",
      100,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.destroy();

    await expect(restoring).rejects.toMatchObject({
      name: "SessionStorageRestoreError",
      unapplied: [RECORDS[0]],
    });
    expect(fixture.isAttached()).toBe(false);
  });

  test("times out a stalled verification and cleans up", async () => {
    const fixture = createRestoreContents({ hangVerification: true });

    await expect(
      installSessionStorageRestore(fixture.contents, [RECORDS[0]], "https://example.com", 5),
    ).rejects.toMatchObject({
      name: "SessionStorageRestoreError",
      unapplied: [RECORDS[0]],
    });
    expect(fixture.isAttached()).toBe(false);
  });

  test("restore script exposes records only to their exact origin", () => {
    const records = [RECORDS[0], { origin: "https://example.com", key: "broken", value: "value" }];
    const script = buildSessionStorageRestoreScript(records);
    const values = new Map<string, string>();
    const context = {
      location: { origin: "https://example.com" },
      sessionStorage: {
        setItem: (key: string, value: string) => {
          if (key === "broken") throw new Error("quota");
          values.set(key, value);
        },
      },
    };
    vm.runInNewContext(script, context);
    vm.runInNewContext(script, context);

    expect([...values]).toEqual([["token", "session-secret"]]);
  });
});
