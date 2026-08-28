import { describe, expect, test } from "vitest";
import { createBrowserCommand } from "./index.js";

describe("browser command", () => {
  test("exposes profile management and open commands", () => {
    const command = createBrowserCommand();
    expect(command.commands.map((child) => child.name())).toEqual([
      "profiles",
      "create-profile",
      "delete-profile",
      "open",
    ]);
    expect(
      command.commands
        .find((child) => child.name() === "open")
        ?.options.map((option) => option.long),
    ).toContain("--profile");
  });
});
