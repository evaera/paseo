import { describe, expect, test } from "vitest";
import { BrowserAutomationCommandSchema, BrowserAutomationResultSchema } from "./rpc-schemas.js";

describe("browser data import protocol", () => {
  test("accepts source discovery and Default-implicit import commands", () => {
    expect(
      BrowserAutomationCommandSchema.parse({ command: "list_import_sources", args: {} }),
    ).toEqual({ command: "list_import_sources", args: {} });
    expect(
      BrowserAutomationCommandSchema.parse({
        command: "import_browser_data",
        args: {
          sourceBrowserId: "chrome",
          sourceProfileId: "Default",
          domains: ["example.com"],
          categories: ["cookies", "localStorage", "sessionStorage"],
        },
      }),
    ).toEqual({
      command: "import_browser_data",
      args: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies", "localStorage", "sessionStorage"],
        confirmMerge: false,
      },
    });
  });

  test("rejects undeclared destination and secret fields", () => {
    const base = {
      command: "import_browser_data",
      args: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies"],
        confirmMerge: true,
      },
    };
    expect(
      BrowserAutomationCommandSchema.safeParse({
        ...base,
        args: { ...base.args, destination: "other" },
      }).success,
    ).toBe(false);
    expect(
      BrowserAutomationCommandSchema.safeParse({
        ...base,
        args: { ...base.args, cookieValue: "secret" },
      }).success,
    ).toBe(false);
  });

  test("returns only counts and warnings with optional queued counts", () => {
    const result = BrowserAutomationResultSchema.parse({
      command: "import_browser_data",
      counts: {
        cookies: { imported: 2, skipped: 1 },
        localStorage: { imported: 1, skipped: 0 },
        sessionStorage: { imported: 0, skipped: 1, queued: 3 },
      },
      warnings: ["Some records were skipped."],
    });
    expect(result).toEqual({
      command: "import_browser_data",
      counts: {
        cookies: { imported: 2, skipped: 1 },
        localStorage: { imported: 1, skipped: 0 },
        sessionStorage: { imported: 0, skipped: 1, queued: 3 },
      },
      warnings: ["Some records were skipped."],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("enforces domain and category limits", () => {
    const args = {
      sourceBrowserId: "chrome",
      sourceProfileId: "Default",
      domains: Array.from({ length: 101 }, (_, index) => `host-${index}.example.com`),
      categories: ["cookies"],
      confirmMerge: false,
    };
    expect(
      BrowserAutomationCommandSchema.safeParse({ command: "import_browser_data", args }).success,
    ).toBe(false);
    expect(
      BrowserAutomationCommandSchema.safeParse({
        command: "import_browser_data",
        args: { ...args, domains: ["example.com"], categories: ["history"] },
      }).success,
    ).toBe(false);
  });
});
