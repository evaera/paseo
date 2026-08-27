import { describe, expect, it } from "vitest";
import { openTarget, parsePosition, placement } from "./index.js";

describe("layout CLI", () => {
  it("expresses opening a terminal in a right split", () => {
    expect(openTarget("terminal", "terminal-1")).toEqual({
      kind: "terminal",
      terminalId: "terminal-1",
    });
    expect(placement({ split: "right", targetPane: "pane-1" })).toEqual({
      mode: "split",
      targetPaneId: "pane-1",
      position: "right",
    });
  });

  it("validates placement enums and requires a split target", () => {
    expect(parsePosition("left")).toBe("left");
    expect(() => parsePosition("diagonal")).toThrow("Expected left, right, top, or bottom");
    expect(() => placement({ split: "right" })).toThrow();
  });
});
