---
title: Browser tools
description: The browser_* MCP tools agents use to drive Paseo browser tabs.
nav: Tools reference
order: 37
category: Browser
---

# Browser tools

The `browser_*` tools are injected into agents alongside the other [Paseo MCP tools](/docs/mcp) when [browser automation](/docs/browser) is enabled.

Shared concepts:

- **`browserId`** identifies a tab. It comes from `browser_new_tab` or `browser_list_tabs` and is required by every tab-scoped tool.
- **`profileId`** identifies a persistent browser profile. Tab results include both `profileId` and its display-only `profileName`; pass the ID back to `browser_new_tab` when you need the same cookie jar.
- **`ref`** identifies an element, e.g. `@e3`. Refs come from the latest `browser_snapshot` of the same tab and expire when the page changes — stale refs return an error instead of acting on the wrong element.
- Every result reports **dialogs** the page opened during the command (alerts accepted; confirm/prompt/beforeunload dismissed).

Arguments marked `?` are optional.

## Tabs

| Tool                | Arguments                  | Purpose                                                                   |
| ------------------- | -------------------------- | ------------------------------------------------------------------------- |
| `browser_list_tabs` | —                          | List open tabs with their `browserId`, `profileId`, and `profileName`.    |
| `browser_new_tab`   | `url?, profile?`           | Open a background tab, optionally using a profile name or ID.             |
| `browser_close_tab` | `browserId`                | Close a tab and clean up its webview.                                     |
| `browser_resize`    | `browserId, width, height` | Resize the tab's viewport — check a layout at phone or tablet dimensions. |

## Profiles

Profiles isolate cookies, logins, caches, and site storage. `Default` is always present and cannot be deleted. Creating and deleting profiles requires one connected desktop browser host. Deletion opens a native confirmation on that host, including when an agent or CLI requested it.

| Tool                     | Arguments | Purpose                                                     |
| ------------------------ | --------- | ----------------------------------------------------------- |
| `browser_list_profiles`  | —         | List profile names and IDs, with Default first.             |
| `browser_create_profile` | `name`    | Create an empty persistent profile.                         |
| `browser_delete_profile` | `profile` | Request deletion by name or ID, including all browser data. |

## Reading the page

| Tool                 | Arguments                              | Purpose                                                                               |
| -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| `browser_snapshot`   | `browserId`                            | Return the page as an accessibility tree with element refs.                           |
| `browser_screenshot` | `browserId, fullPage?`                 | Capture a PNG of the viewport, or the full page with `fullPage`.                      |
| `browser_logs`       | `browserId, maxEntries?`               | Read recent console messages and network timing entries.                              |
| `browser_wait`       | `browserId, text? \| url?, timeoutMs?` | Wait until the page contains text or reaches a URL fragment (exactly one of the two). |

## Interacting

| Tool               | Arguments                                           | Purpose                                                                              |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `browser_click`    | `browserId, ref, button?, doubleClick?, modifiers?` | Click an element — left/right/middle, double-click, keyboard modifiers.              |
| `browser_fill`     | `browserId, ref, value`                             | Set the value of an input-like element.                                              |
| `browser_type`     | `browserId, text, ref?`                             | Type text into an element, or into the focused element when `ref` is omitted.        |
| `browser_keypress` | `browserId, key, ref?`                              | Press a key (`Enter`, `Escape`, `Tab`, `Space`, …) on an element or the focused one. |
| `browser_hover`    | `browserId, ref`                                    | Hover an element — triggers real CSS `:hover`.                                       |
| `browser_select`   | `browserId, ref, value`                             | Choose an option in a `<select>`.                                                    |
| `browser_drag`     | `browserId, sourceRef, targetRef`                   | Drag one element onto another.                                                       |
| `browser_upload`   | `browserId, ref, filePaths`                         | Set files on a file input. Paths must be inside the agent's workspace.               |
| `browser_scroll`   | `browserId, deltaX, deltaY, ref?`                   | Scroll the page, or center the wheel input over an element with `ref`.               |

## Navigation

| Tool               | Arguments        | Purpose                                             |
| ------------------ | ---------------- | --------------------------------------------------- |
| `browser_navigate` | `browserId, url` | Go to an `http(s)` URL.                             |
| `browser_back`     | `browserId`      | Go back — errors when there is no history to go to. |
| `browser_forward`  | `browserId`      | Go forward — errors when there is no forward entry. |
| `browser_reload`   | `browserId`      | Reload the page.                                    |

## Scripting

| Tool               | Arguments                   | Purpose                                                                                                                                  |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_evaluate` | `browserId, function, ref?` | Run a JavaScript function in the page. With `ref`, the resolved element is passed as the first argument. Results return as bounded JSON. |

## Errors

Tools return structured errors rather than failing silently. The ones agents see most:

| Code                | Meaning                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `browser_disabled`  | Browser tools are turned off on this host.                                      |
| `browser_no_host`   | No browser host (desktop app) is connected. Retryable.                          |
| `browser_stale_ref` | The ref no longer matches the page — take a new snapshot.                       |
| `browser_timeout`   | The element never became actionable, or the wait condition never held.          |
| `browser_denied`    | The action isn't allowed — e.g. a non-`http(s)` URL, or no history to navigate. |
