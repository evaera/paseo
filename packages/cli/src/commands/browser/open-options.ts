export function resolveBrowserWorkspaceId(
  explicitWorkspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return explicitWorkspace?.trim() || env.PASEO_WORKSPACE_ID?.trim() || undefined;
}

export function validateExternalBrowserOpen(
  url: string | undefined,
  options: { workspace?: string },
): string {
  if (!url) {
    throw new Error("paseo browser open --external requires an HTTP(S) URL");
  }
  if (options.workspace) {
    throw new Error("--external cannot be combined with --workspace");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("paseo browser open --external requires an HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("paseo browser open --external requires an HTTP(S) URL");
  }
  return url;
}
