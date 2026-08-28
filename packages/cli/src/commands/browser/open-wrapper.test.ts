import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const wrapperSource = new URL("../../../bin/open", import.meta.url);
let root: string;
let wrapper: string;
let routedLog: string;
let systemLog: string;

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(wrapper, args, {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PASEO_WORKSPACE_ID: "workspace-1",
      PASEO_OPEN_WRAPPER_CLI: join(root, "paseo"),
      PASEO_OPEN_WRAPPER_SYSTEM_OPEN: join(root, "system-open"),
      ROUTED_LOG: routedLog,
      SYSTEM_LOG: systemLog,
      ...env,
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-open-wrapper-"));
  wrapper = join(root, "open");
  routedLog = join(root, "routed.log");
  systemLog = join(root, "system.log");
  copyFileSync(wrapperSource, wrapper);
  chmodSync(wrapper, 0o755);
  executable(join(root, "paseo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROUTED_LOG"\n');
  executable(join(root, "system-open"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SYSTEM_LOG"\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("macOS open wrapper", () => {
  test("routes HTTP URLs through the Service URLs policy command", () => {
    const result = run(["https://example.com/review"]);
    expect(result.status).toBe(0);
    expect(readFileSync(routedLog, "utf8")).toBe(
      "browser open-service-url https://example.com/review\n",
    );
  });

  test.each([
    ["missing workspace", ["https://example.com"], { PASEO_WORKSPACE_ID: "" }],
    ["external opt-out", ["https://example.com"], { PASEO_BROWSER_OPEN_EXTERNAL: "1" }],
    ["explicit flags", ["-a", "Safari", "https://example.com"], {}],
    ["non-http scheme", ["mailto:test@example.com"], {}],
    ["recursive invocation", ["https://example.com"], { PASEO_BROWSER_OPEN_ROUTING: "1" }],
  ])("passes through %s", (_name, args, env) => {
    const result = run(args, env);
    expect(result.status).toBe(0);
    expect(readFileSync(systemLog, "utf8")).toBe(`${args.join(" ")}\n`);
  });

  test("accepted dispatch exits without fallback while a slow ask remains pending", () => {
    executable(
      join(root, "paseo"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROUTED_LOG"\n(sleep 1; printf done > "$ROUTED_LOG.ask") >/dev/null 2>&1 &\nexit 0\n',
    );
    const started = Date.now();
    expect(run(["https://example.com/ask"]).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(750);
    expect(existsSync(systemLog)).toBe(false);
  });

  test("cold accepted dispatch completes within the default margin without double-opening", () => {
    executable(join(root, "paseo"), '#!/bin/sh\nsleep 3\nprintf "%s\\n" "$*" >> "$ROUTED_LOG"\n');
    const started = Date.now();
    expect(run(["https://example.com/cold"]).status).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(existsSync(systemLog)).toBe(false);
  });

  test("an unavailable compatible host falls back to the system browser", () => {
    executable(join(root, "paseo"), "#!/bin/sh\nexit 7\n");
    expect(run(["https://example.com/fallback"]).status).toBe(0);
    expect(readFileSync(systemLog, "utf8")).toBe("https://example.com/fallback\n");
  });

  test("routes multiple URLs independently without double-opening successes", () => {
    executable(
      join(root, "paseo"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROUTED_LOG"\ncase "$*" in *fail*) exit 7;; esac\n',
    );
    const args = [
      "https://example.com/success",
      "notes.txt",
      "https://example.com/fail",
      "mailto:test@example.com",
    ];
    expect(run(args).status).toBe(0);
    expect(readFileSync(routedLog, "utf8")).toBe(
      "browser open-service-url https://example.com/success\nbrowser open-service-url https://example.com/fail\n",
    );
    expect(readFileSync(systemLog, "utf8")).toBe(
      "notes.txt https://example.com/fail mailto:test@example.com\n",
    );
  });

  test("times out a hung route and falls back quickly", () => {
    executable(join(root, "paseo"), "#!/bin/sh\nsleep 5\n");
    const started = Date.now();
    expect(run(["https://example.com"], { PASEO_OPEN_WRAPPER_TIMEOUT_TICKS: "2" }).status).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(readFileSync(systemLog, "utf8")).toBe("https://example.com\n");
  });

  test("works when a Node tool spawns the configured BROWSER like Plannotator", () => {
    const url = "https://example.com/plannotator-review";
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        'require("node:child_process").spawnSync(process.env.BROWSER, [process.argv[1]], { env: process.env })',
        url,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BROWSER: wrapper,
          PASEO_WORKSPACE_ID: "workspace-1",
          PASEO_OPEN_WRAPPER_CLI: join(root, "paseo"),
          PASEO_OPEN_WRAPPER_SYSTEM_OPEN: join(root, "system-open"),
          ROUTED_LOG: routedLog,
          SYSTEM_LOG: systemLog,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(routedLog, "utf8")).toBe(`browser open-service-url ${url}\n`);
  });
});
