import { describe, expect, test } from "vitest";
import {
  requireBrowserWorkspaceId,
  resolveBrowserWorkspaceId,
  validateExternalBrowserOpen,
  validateServiceUrl,
} from "./open-options.js";

describe("browser open options", () => {
  test("service URL policy command accepts only absolute HTTP(S) URLs", () => {
    expect(validateServiceUrl("HTTPS://EXAMPLE.COM:443/a/../service")).toBe(
      "https://example.com/service",
    );
    expect(() => validateServiceUrl("example.com")).toThrow(/HTTP\(S\)/);
    expect(() => validateServiceUrl("file:///tmp/review.html")).toThrow(/HTTP\(S\)/);
    expect(() => validateServiceUrl("https://trusted.example/\n@evil.example")).toThrow(
      /whitespace/,
    );
  });

  test("validates external opens and rejects in-app-only options", () => {
    expect(validateExternalBrowserOpen("https://example.com", {})).toBe("https://example.com/");
    expect(() => validateExternalBrowserOpen("file:///tmp/review.html", {})).toThrow(/HTTP\(S\)/);
    expect(() => validateExternalBrowserOpen("mailto:test@example.com", {})).toThrow(/HTTP\(S\)/);
    expect(() =>
      validateExternalBrowserOpen("https://example.com", { workspace: "workspace-1" }),
    ).toThrow(/cannot be combined/);
  });

  test("service URL command requires workspace context before RPC", () => {
    expect(() => requireBrowserWorkspaceId(undefined, {})).toThrow(/requires --workspace/);
    expect(requireBrowserWorkspaceId(undefined, { PASEO_WORKSPACE_ID: "workspace-1" })).toBe(
      "workspace-1",
    );
  });

  test("defaults browser opens to the current workspace", () => {
    expect(resolveBrowserWorkspaceId(undefined, { PASEO_WORKSPACE_ID: " workspace-1 " })).toBe(
      "workspace-1",
    );
    expect(resolveBrowserWorkspaceId("explicit", { PASEO_WORKSPACE_ID: "workspace-1" })).toBe(
      "explicit",
    );
    expect(resolveBrowserWorkspaceId(undefined, {})).toBeUndefined();
  });
});
