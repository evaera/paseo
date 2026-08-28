import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { loadAppSettingsFromStorage, persistAppSettings } from "@/hooks/use-settings";
import type { ServiceUrlBehavior } from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  canonicalizeServiceUrl,
  resolveServiceUrlDisposition,
  type ServiceUrlDisposition,
  type ServiceUrlPolicyDependencies,
} from "./service-url-policy";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export type OpenServiceUrlDisposition = ServiceUrlDisposition;

export interface OpenServiceUrlDependencies extends ServiceUrlPolicyDependencies {
  isElectron: () => boolean;
  openExternal: (url: string) => Promise<void>;
}

function productionDependencies(): OpenServiceUrlDependencies {
  const askWithCheckbox = getDesktopHost()?.dialog?.askWithCheckbox;
  return {
    isElectron: isElectronRuntime,
    loadBehavior: async (): Promise<ServiceUrlBehavior> =>
      (await loadAppSettingsFromStorage()).serviceUrlBehavior,
    persistBehavior: async (serviceUrlBehavior) => persistAppSettings({ serviceUrlBehavior }),
    ask: askWithCheckbox
      ? async (displayUrl) =>
          askWithCheckbox(i18n.t("serviceUrl.message", { url: displayUrl }), {
            title: i18n.t("serviceUrl.title"),
            okLabel: i18n.t("serviceUrl.inPaseo"),
            cancelLabel: i18n.t("serviceUrl.externalBrowser"),
            dismissLabel: i18n.t("common.actions.cancel"),
            checkboxLabel: i18n.t("serviceUrl.dontAskAgain"),
          })
      : undefined,
    openExternal: openExternalUrl,
  };
}

export async function openServiceUrl(
  url: string,
  options?: OpenServiceUrlOptions,
): Promise<OpenServiceUrlDisposition> {
  return openServiceUrlWithDependencies(url, options, productionDependencies());
}

export async function openServiceUrlWithDependencies(
  url: string,
  options: OpenServiceUrlOptions | undefined,
  dependencies: OpenServiceUrlDependencies,
): Promise<OpenServiceUrlDisposition> {
  const canonicalUrl = canonicalizeServiceUrl(url);
  options?.signal?.throwIfAborted();
  if (!dependencies.isElectron()) {
    await dependencies.openExternal(canonicalUrl);
    return "external";
  }

  const behavior = await resolveServiceUrlDisposition(canonicalUrl, dependencies, options?.signal);
  if (behavior === "in-app") {
    const openInApp = options?.openInApp;
    if (!openInApp) {
      throw new Error("The Service URLs setting requires a Paseo browser workspace.");
    }
    options?.signal?.throwIfAborted();
    await openInApp(canonicalUrl);
  } else if (behavior === "external") {
    options?.signal?.throwIfAborted();
    await dependencies.openExternal(canonicalUrl);
  }
  return behavior;
}
