import { describe, expect, test } from "vitest";
import { resolveBrowserWorkspaceId, validateExternalBrowserOpen } from "./open-options.js";

describe("browser open options", () => {
  test("validates external opens and rejects in-app-only options", () => {
    expect(validateExternalBrowserOpen("https://example.com", {})).toBe("https://example.com");
    expect(() => validateExternalBrowserOpen("file:///tmp/review.html", {})).toThrow(/HTTP\(S\)/);
    expect(() => validateExternalBrowserOpen("mailto:test@example.com", {})).toThrow(/HTTP\(S\)/);
    expect(() =>
      validateExternalBrowserOpen("https://example.com", { workspace: "workspace-1" }),
    ).toThrow(/cannot be combined/);
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
