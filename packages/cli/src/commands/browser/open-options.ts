function hasControlOrWhitespace(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 32 || code === 127;
  });
}

export function resolveBrowserWorkspaceId(
  explicitWorkspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitWorkspace?.trim() || env.PASEO_WORKSPACE_ID?.trim() || undefined;
}

function validateHttpUrl(url: string | undefined, errorMessage: string): string {
  if (!url || hasControlOrWhitespace(url)) throw new Error(errorMessage);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(errorMessage);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(errorMessage);
  return parsed.href;
}

export function requireBrowserWorkspaceId(
  explicitWorkspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const workspaceId = resolveBrowserWorkspaceId(explicitWorkspace, env);
  if (!workspaceId) {
    throw new Error("paseo browser open-service-url requires --workspace or PASEO_WORKSPACE_ID");
  }
  return workspaceId;
}

export function validateServiceUrl(url: string | undefined): string {
  return validateHttpUrl(
    url,
    "paseo browser open-service-url requires an HTTP(S) URL without whitespace",
  );
}

export function validateExternalBrowserOpen(
  url: string | undefined,
  options: { workspace?: string },
): string {
  if (options.workspace) {
    throw new Error("--external cannot be combined with --workspace");
  }
  return validateHttpUrl(
    url,
    "paseo browser open --external requires an HTTP(S) URL without whitespace",
  );
}
