import { describe, expect, test } from "vitest";
import { BrowserAutomationCommandSchema, BrowserAutomationResultSchema } from "./rpc-schemas.js";

describe("browser profile automation", () => {
  test("accepts profile management commands", () => {
    expect(BrowserAutomationCommandSchema.parse({ command: "list_profiles", args: {} })).toEqual({
      command: "list_profiles",
      args: {},
    });
    expect(
      BrowserAutomationCommandSchema.parse({ command: "create_profile", args: { name: "Work" } }),
    ).toMatchObject({ command: "create_profile", args: { name: "Work" } });
    expect(
      BrowserAutomationCommandSchema.parse({
        command: "delete_profile",
        args: { profile: "Work" },
      }),
    ).toMatchObject({ command: "delete_profile", args: { profile: "Work" } });
  });

  test("keeps new-tab profile input and result metadata optional", () => {
    expect(BrowserAutomationCommandSchema.parse({ command: "new_tab", args: {} })).toEqual({
      command: "new_tab",
      args: {},
    });
    expect(
      BrowserAutomationCommandSchema.parse({ command: "new_tab", args: { profile: "Personal" } }),
    ).toMatchObject({ command: "new_tab", args: { profile: "Personal" } });
    expect(
      BrowserAutomationResultSchema.parse({
        command: "new_tab",
        browserId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "workspace-1",
        url: "https://example.com",
      }),
    ).toMatchObject({ command: "new_tab" });
  });

  test("validates profile results", () => {
    expect(
      BrowserAutomationResultSchema.parse({
        command: "list_profiles",
        profiles: [{ id: "default", name: "Default", createdAt: 0 }],
      }),
    ).toMatchObject({ command: "list_profiles" });
  });
});
