import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { injectBrowserLinkRouting, resolveBrowserOpenWrapperPath } from "./browser-link-routing.js";

const roots: string[] = [];

function executable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "paseo-browser-routing-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("browser open wrapper resolution", () => {
  test("is strictly gated to darwin", () => {
    expect(
      resolveBrowserOpenWrapperPath({ platform: "linux", cliEntrypoint: "/unused" }),
    ).toBeNull();
    expect(
      injectBrowserLinkRouting(
        { PATH: "/usr/bin", PASEO_WORKSPACE_ID: "workspace-1" },
        undefined,
        "/unused",
        "linux",
      ),
    ).toEqual({ PATH: "/usr/bin", PASEO_WORKSPACE_ID: "workspace-1" });
  });

  test("resolves an executable source wrapper beside the real CLI", () => {
    const dir = root();
    const cli = join(dir, "bin", "paseo");
    const wrapper = join(dir, "bin", "open");
    executable(cli);
    executable(wrapper);

    expect(resolveBrowserOpenWrapperPath({ platform: "darwin", cliEntrypoint: cli })).toBe(
      realpathSync(wrapper),
    );
  });

  test("resolves the dedicated packaged wrapper from an asar entrypoint", () => {
    const resources = join(root(), "Paseo.app", "Contents", "Resources");
    const cli = join(resources, "bin", "paseo");
    const wrapper = join(resources, "open-wrapper", "open");
    executable(cli);
    executable(wrapper);
    const entrypoint = join(
      resources,
      "app.asar",
      "node_modules",
      "@getpaseo",
      "cli",
      "bin",
      "paseo",
    );

    expect(resolveBrowserOpenWrapperPath({ platform: "darwin", cliEntrypoint: entrypoint })).toBe(
      realpathSync(wrapper),
    );
  });

  test("realpaths PASEO_CLI and requires both executables", () => {
    const dir = root();
    const cli = join(dir, "Resources", "bin", "paseo");
    const wrapper = join(dir, "Resources", "open-wrapper", "open");
    const link = join(dir, "paseo-link");
    executable(cli);
    executable(wrapper);
    symlinkSync(cli, link);

    expect(
      resolveBrowserOpenWrapperPath({
        platform: "darwin",
        env: { PASEO_CLI: link },
        cliEntrypoint: null,
      }),
    ).toBe(realpathSync(wrapper));
    chmodSync(wrapper, 0o644);
    expect(
      resolveBrowserOpenWrapperPath({
        platform: "darwin",
        env: { PASEO_CLI: link },
        cliEntrypoint: null,
      }),
    ).toBeNull();
  });
});

describe("browser link routing environment", () => {
  test("prefixes only the wrapper directory and preserves an explicit BROWSER", () => {
    const dir = root();
    const wrapper = join(dir, "open-wrapper", "open");
    executable(wrapper);
    const env = injectBrowserLinkRouting(
      { PATH: "/custom/bin", BROWSER: "/custom/browser", PASEO_WORKSPACE_ID: "workspace-1" },
      undefined,
      wrapper,
      "darwin",
    );

    expect(env.PATH).toBe(`${dirname(realpathSync(wrapper))}${delimiter}/custom/bin`);
    expect(env.BROWSER).toBe("/custom/browser");
  });

  test("replaces BROWSER only with the explicit Paseo override", () => {
    const dir = root();
    const wrapper = join(dir, "open-wrapper", "open");
    executable(wrapper);
    const env = injectBrowserLinkRouting(
      {
        PATH: "/custom/bin",
        BROWSER: "/custom/browser",
        PASEO_BROWSER_OPEN_OVERRIDE: "1",
        PASEO_WORKSPACE_ID: "workspace-1",
      },
      undefined,
      wrapper,
      "darwin",
    );

    expect(env.BROWSER).toBe(realpathSync(wrapper));
  });
});
