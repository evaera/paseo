import type { ServiceUrlBehavior } from "../hooks/use-settings/storage";

export type ServiceUrlDisposition = "dismissed" | Exclude<ServiceUrlBehavior, "ask">;

function hasControlOrWhitespace(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}
export const MAX_SERVICE_URL_DIALOG_CHARS = 300;

export interface ServiceUrlPolicyDependencies {
  loadBehavior: () => Promise<ServiceUrlBehavior>;
  persistBehavior: (behavior: Exclude<ServiceUrlBehavior, "ask">) => Promise<void>;
  ask?: (
    displayUrl: string,
  ) => Promise<{ confirmed: boolean; dismissed: boolean; dontAskAgain: boolean }>;
}

export function canonicalizeServiceUrl(url: string): string {
  if (hasControlOrWhitespace(url)) {
    throw new Error("Service URL must not contain control characters or whitespace.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Service URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Service URL must use HTTP or HTTPS.");
  }
  return parsed.href;
}

export function serviceUrlForDialog(url: string): string {
  if (url.length <= MAX_SERVICE_URL_DIALOG_CHARS) return url;
  return `${url.slice(0, MAX_SERVICE_URL_DIALOG_CHARS - 1)}…`;
}

export async function resolveServiceUrlDisposition(
  canonicalUrl: string,
  dependencies: ServiceUrlPolicyDependencies,
  signal?: AbortSignal,
): Promise<ServiceUrlDisposition> {
  signal?.throwIfAborted();
  const behavior = await dependencies.loadBehavior();
  signal?.throwIfAborted();
  if (behavior === "in-app" || behavior === "external") return behavior;
  if (!dependencies.ask) {
    throw new Error("The Service URLs setting requires a choice, but no dialog can be shown.");
  }

  const result = await dependencies.ask(serviceUrlForDialog(canonicalUrl));
  signal?.throwIfAborted();
  if (result.dismissed) return "dismissed";
  const choice = result.confirmed ? "in-app" : "external";
  if (result.dontAskAgain) {
    signal?.throwIfAborted();
    await dependencies.persistBehavior(choice);
  }
  return choice;
}
