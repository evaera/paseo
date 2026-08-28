import { describe, expect, it } from "vitest";
import { collectAllPanes, createDefaultLayout } from "@/stores/workspace-layout-actions";
import { movePaneInLayout } from "./workspace-layout-move-pane";

const ids = {
  createNodeId: (prefix: "pane" | "group") => `${prefix}_new`,
  createFocusRestorationToken: () => "focus-1",
};

describe("movePaneInLayout", () => {
  it("preserves the moved pane ID while changing its position", () => {
    const layout = createDefaultLayout();
    const originalPane = collectAllPanes(layout.root)[0]!;
    const secondPaneId = "pane_second";
    const withSecond = {
      ...layout,
      root: {
        kind: "group" as const,
        group: {
          id: "group_original",
          direction: "horizontal" as const,
          sizes: [0.5, 0.5],
          children: [
            layout.root,
            { kind: "pane" as const, pane: { id: secondPaneId, tabIds: [], focusedTabId: null } },
          ],
        },
      },
    };

    const moved = movePaneInLayout({
      layout: withSecond,
      paneId: originalPane.id,
      targetPaneId: secondPaneId,
      position: "bottom",
      ids,
    });
    expect(moved?.focusedPaneId).toBe(originalPane.id);
    expect(
      collectAllPanes(moved!.root)
        .map((pane) => pane.id)
        .sort(),
    ).toEqual([originalPane.id, secondPaneId].sort());
    expect(moved?.root).toMatchObject({ kind: "group", group: { direction: "vertical" } });
  });
});
