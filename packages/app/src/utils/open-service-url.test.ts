import { describe, expect, test } from "vitest";
import {
  openServiceUrlWithDependencies,
  type OpenServiceUrlDependencies,
} from "./open-service-url";

function createHarness(behavior: "in-app" | "external") {
  const openedInApp: string[] = [];
  const openedExternally: string[] = [];
  const dependencies: OpenServiceUrlDependencies = {
    isElectron: () => true,
    loadBehavior: async () => behavior,
    persistBehavior: async () => {},
    openExternal: async (url) => {
      openedExternally.push(url);
    },
  };
  const open = (url = "https://SERVICE.localhost:443/a/../") =>
    openServiceUrlWithDependencies(
      url,
      {
        openInApp: async (nextUrl) => {
          openedInApp.push(nextUrl);
        },
      },
      dependencies,
    );
  return { openedInApp, openedExternally, open };
}

describe("openServiceUrl", () => {
  test("in-app opens the canonical URL in a Paseo browser tab", async () => {
    const harness = createHarness("in-app");
    await expect(harness.open()).resolves.toBe("in-app");
    expect(harness.openedInApp).toEqual(["https://service.localhost/"]);
    expect(harness.openedExternally).toEqual([]);
  });

  test("in-app fails closed without an available workspace browser", async () => {
    const harness = createHarness("in-app");
    await expect(
      openServiceUrlWithDependencies("https://service.localhost", undefined, {
        isElectron: () => true,
        loadBehavior: async () => "in-app",
        persistBehavior: async () => {},
        openExternal: async (url) => {
          harness.openedExternally.push(url);
        },
      }),
    ).rejects.toThrow(/workspace/);
    expect(harness.openedExternally).toEqual([]);
  });

  test("dismissed ask opens nothing", async () => {
    const openedInApp: string[] = [];
    const openedExternally: string[] = [];
    await expect(
      openServiceUrlWithDependencies(
        "https://service.localhost",
        { openInApp: async (url) => void openedInApp.push(url) },
        {
          isElectron: () => true,
          loadBehavior: async () => "ask",
          persistBehavior: async () => {},
          ask: async () => ({ confirmed: false, dismissed: true, dontAskAgain: false }),
          openExternal: async (url) => void openedExternally.push(url),
        },
      ),
    ).resolves.toBe("dismissed");
    expect(openedInApp).toEqual([]);
    expect(openedExternally).toEqual([]);
  });

  test("external explicitly opens the canonical URL in the system browser", async () => {
    const harness = createHarness("external");
    await expect(harness.open()).resolves.toBe("external");
    expect(harness.openedInApp).toEqual([]);
    expect(harness.openedExternally).toEqual(["https://service.localhost/"]);
  });
});
