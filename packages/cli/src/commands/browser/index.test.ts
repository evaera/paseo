import { describe, expect, test, vi } from "vitest";

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(),
}));

import { createBrowserCommand } from "./index.js";

describe("browser command", () => {
  test("exposes only routing-owned browser commands", () => {
    const command = createBrowserCommand();
    expect(command.commands.map((child) => child.name())).toEqual(["open-service-url", "open"]);
    expect(
      command.commands
        .find((child) => child.name() === "open")
        ?.options.map((option) => option.long),
    ).toEqual(expect.arrayContaining(["--workspace", "--external"]));
    expect(
      command.commands
        .find((child) => child.name() === "open-service-url")
        ?.options.map((option) => option.long),
    ).toEqual(expect.arrayContaining(["--workspace", "--wait"]));
  });
});
