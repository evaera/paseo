import { describe, expect, test } from "vitest";
import { createBrowserCommand } from "./index.js";

describe("browser command", () => {
  test("exposes profiles, Default-only import, routing, pane placement, and open commands", () => {
    const command = createBrowserCommand();
    expect(command.commands.map((child) => child.name())).toEqual([
      "profiles",
      "create-profile",
      "delete-profile",
      "import-sources",
      "import",
      "open-service-url",
      "open",
    ]);

    const openOptions = command.commands
      .find((child) => child.name() === "open")
      ?.options.map((option) => option.long);
    expect(openOptions).toEqual(
      expect.arrayContaining([
        "--profile",
        "--workspace",
        "--pane",
        "--split",
        "--target-pane",
        "--external",
      ]),
    );

    const importCommand = command.commands.find((child) => child.name() === "import");
    expect(importCommand?.options.map((option) => option.long)).toEqual([
      "--source-browser",
      "--source-profile",
      "--domains",
      "--categories",
      "--confirm-merge",
      "--json",
      "--host",
    ]);
    expect(
      importCommand?.options.find((option) => option.long === "--domains")?.description,
    ).toContain("fully displayed list must not exceed 1,000 characters");
    expect(importCommand?.description()).toContain("Default browser session");

    expect(
      command.commands
        .find((child) => child.name() === "open-service-url")
        ?.options.map((option) => option.long),
    ).toEqual(expect.arrayContaining(["--workspace", "--wait"]));
  });
});
