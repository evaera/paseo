import type { SplitNode, WorkspaceLayout } from "@/stores/workspace-layout-actions";
import type { WorkspaceLayoutIdSource } from "@/stores/workspace-layout-ids";

export function movePaneInLayout(input: {
  layout: WorkspaceLayout;
  paneId: string;
  targetPaneId: string;
  position: "left" | "right" | "top" | "bottom";
  ids: WorkspaceLayoutIdSource;
}): WorkspaceLayout | null {
  if (input.paneId === input.targetPaneId) return null;
  const detached = detachPane(input.layout.root, input.paneId);
  if (!detached.node || !detached.pane || !findPane(detached.node, input.targetPaneId)) return null;
  const inserted = insertPane(
    detached.node,
    input.targetPaneId,
    detached.pane,
    input.position,
    input.ids,
  );
  if (!inserted) return null;
  return { ...input.layout, root: inserted, focusedPaneId: input.paneId };
}

function detachPane(
  node: SplitNode,
  paneId: string,
): { node: SplitNode | null; pane: SplitNode | null } {
  if (node.kind === "pane") {
    return node.pane.id === paneId ? { node: null, pane: node } : { node, pane: null };
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const child = detachPane(node.group.children[index]!, paneId);
    if (!child.pane) continue;
    const children = node.group.children.slice();
    const sizes = node.group.sizes.slice();
    if (child.node) {
      children[index] = child.node;
    } else {
      children.splice(index, 1);
      sizes.splice(index, 1);
    }
    if (children.length === 0) return { node: null, pane: child.pane };
    if (children.length === 1) return { node: children[0]!, pane: child.pane };
    const total = sizes.reduce((sum, size) => sum + size, 0);
    return {
      node: {
        kind: "group",
        group: {
          ...node.group,
          children,
          sizes:
            total > 0 ? sizes.map((size) => size / total) : children.map(() => 1 / children.length),
        },
      },
      pane: child.pane,
    };
  }
  return { node, pane: null };
}

function insertPane(
  node: SplitNode,
  targetPaneId: string,
  pane: SplitNode,
  position: "left" | "right" | "top" | "bottom",
  ids: WorkspaceLayoutIdSource,
): SplitNode | null {
  if (node.kind === "pane") {
    if (node.pane.id !== targetPaneId) return null;
    const before = position === "left" || position === "top";
    return {
      kind: "group",
      group: {
        id: ids.createNodeId("group"),
        direction: position === "left" || position === "right" ? "horizontal" : "vertical",
        children: before ? [pane, node] : [node, pane],
        sizes: [0.5, 0.5],
      },
    };
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const replacement = insertPane(node.group.children[index]!, targetPaneId, pane, position, ids);
    if (!replacement) continue;
    const children = node.group.children.slice();
    children[index] = replacement;
    return { kind: "group", group: { ...node.group, children } };
  }
  return null;
}

function findPane(node: SplitNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.pane.id === paneId
    : node.group.children.some((child) => findPane(child, paneId));
}
