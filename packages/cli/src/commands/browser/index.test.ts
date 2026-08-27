import { describe, expect, test } from "vitest";
import { createBrowserCommand } from "./index.js";

describe("browser command", () => {
  test("exposes only the routing-owned open command", () => {
    const command = createBrowserCommand();
    expect(command.commands.map((child) => child.name())).toEqual(["open"]);
    expect(
      command.commands
        .find((child) => child.name() === "open")
        ?.options.map((option) => option.long),
    ).toEqual(expect.arrayContaining(["--workspace", "--external"]));
  });
});
