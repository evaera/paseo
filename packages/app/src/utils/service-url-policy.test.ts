import { describe, expect, test } from "vitest";
import {
  canonicalizeServiceUrl,
  MAX_SERVICE_URL_DIALOG_CHARS,
  resolveServiceUrlDisposition,
  type ServiceUrlDisposition,
  type ServiceUrlPolicyDependencies,
} from "./service-url-policy";

function createHarness(behavior: "ask" | Exclude<ServiceUrlDisposition, "dismissed">) {
  const persisted: ServiceUrlDisposition[] = [];
  const displayed: string[] = [];
  let answer = { confirmed: true, dismissed: false, dontAskAgain: false };
  const dependencies: ServiceUrlPolicyDependencies = {
    loadBehavior: async () => behavior,
    persistBehavior: async (choice) => {
      persisted.push(choice);
    },
    ask: async (url) => {
      displayed.push(url);
      return answer;
    },
  };
  return {
    dependencies,
    persisted,
    displayed,
    setAnswer(next: typeof answer) {
      answer = next;
    },
  };
}

describe("service URL policy", () => {
  test.each([
    [{ confirmed: true, dismissed: false, dontAskAgain: false }, "in-app", []],
    [{ confirmed: false, dismissed: false, dontAskAgain: false }, "external", []],
    [{ confirmed: true, dismissed: false, dontAskAgain: true }, "in-app", ["in-app"]],
    [{ confirmed: false, dismissed: false, dontAskAgain: true }, "external", ["external"]],
  ] as const)("ask honors the choice and persistence", async (answer, disposition, persisted) => {
    const harness = createHarness("ask");
    harness.setAnswer(answer);
    await expect(
      resolveServiceUrlDisposition("https://service.localhost/", harness.dependencies),
    ).resolves.toBe(disposition);
    expect(harness.persisted).toEqual(persisted);
  });

  test("dismiss opens and persists nothing", async () => {
    const harness = createHarness("ask");
    harness.setAnswer({ confirmed: false, dismissed: true, dontAskAgain: true });
    await expect(
      resolveServiceUrlDisposition("https://service.localhost/", harness.dependencies),
    ).resolves.toBe("dismissed");
    expect(harness.persisted).toEqual([]);
  });

  test("ask fails closed when no dialog can be shown", async () => {
    const harness = createHarness("ask");
    harness.dependencies.ask = undefined;
    await expect(
      resolveServiceUrlDisposition("https://service.localhost/", harness.dependencies),
    ).rejects.toThrow(/no dialog/i);
    expect(harness.persisted).toEqual([]);
  });

  test("canonicalizes parsed href and rejects whitespace spoofing", () => {
    expect(canonicalizeServiceUrl("HTTPS://EXAMPLE.COM:443/a/../service?q=1")).toBe(
      "https://example.com/service?q=1",
    );
    expect(() => canonicalizeServiceUrl("https://trusted.example/\n@evil.example/")).toThrow(
      /whitespace/,
    );
    expect(() => canonicalizeServiceUrl("https://trusted.example/\tevil")).toThrow(/whitespace/);
  });

  test("caps the URL shown by the ask dialog without changing the policy URL", async () => {
    const harness = createHarness("ask");
    const url = `https://example.com/${"a".repeat(1000)}`;
    await resolveServiceUrlDisposition(url, harness.dependencies);
    expect(harness.displayed[0]).toHaveLength(MAX_SERVICE_URL_DIALOG_CHARS);
    expect(harness.displayed[0]?.endsWith("…")).toBe(true);
  });
});
