import { describe, expect, test } from "vitest";
import { createBrowserCommand } from "./index.js";

describe("browser command", () => {
  test("exposes only browser data import commands", () => {
    const command = createBrowserCommand();
    expect(command.commands.map((child) => child.name())).toEqual(["import-sources", "import"]);
    expect(
      command.commands
        .find((child) => child.name() === "import")
        ?.options.map((option) => option.long),
    ).toEqual([
      "--source-browser",
      "--source-profile",
      "--domains",
      "--categories",
      "--confirm-merge",
      "--json",
      "--host",
    ]);
  });
});
