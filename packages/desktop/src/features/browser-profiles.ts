import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_BROWSER_PROFILE_ID = "default";
export const DEFAULT_BROWSER_PROFILE_NAME = "Default";
const BROWSER_PROFILES_FILENAME = "browser-profiles.json";
const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROFILE_NAME_LENGTH = 80;

export interface BrowserProfile {
  id: string;
  name: string;
  createdAt: number;
  partition: string;
}
export type BrowserProfileEvent = "browser-profiles-changed" | "browser-profile-deleting";

export function broadcastBrowserProfileEvent(
  windows: ReadonlyArray<{ webContents: { send(channel: string, payload: unknown): void } }>,
  event: BrowserProfileEvent,
  payload: unknown,
): void {
  for (const window of windows) window.webContents.send(`paseo:event:${event}`, payload);
}

export interface BrowserProfilesStore {
  list(): Promise<BrowserProfile[]>;
  create(name: unknown): Promise<BrowserProfile>;
  delete(id: unknown): Promise<boolean>;
  resolveId(id: unknown): Promise<string | null>;
}

export async function deleteBrowserProfileWithConfirmation(input: {
  store: BrowserProfilesStore;
  profileId: unknown;
  confirm: (profile: BrowserProfile) => Promise<boolean>;
  beforeDelete?: (profile: BrowserProfile) => void;
}): Promise<boolean> {
  if (typeof input.profileId !== "string" || input.profileId === DEFAULT_BROWSER_PROFILE_ID) {
    return false;
  }
  const profile = (await input.store.list()).find((candidate) => candidate.id === input.profileId);
  if (!profile || !(await input.confirm(profile))) return false;
  input.beforeDelete?.(profile);
  return input.store.delete(profile.id);
}

const StoredProfileSchema = z.object({
  id: z.string().regex(PROFILE_ID_PATTERN),
  name: z.string().min(1).max(MAX_PROFILE_NAME_LENGTH),
  createdAt: z.number().int().nonnegative(),
});
const StoredDocumentSchema = z.object({
  version: z.literal(1),
  profiles: z.array(StoredProfileSchema),
});
type StoredDocument = z.infer<typeof StoredDocumentSchema>;

export function browserProfilePartition(profileId: string): string {
  return profileId === DEFAULT_BROWSER_PROFILE_ID
    ? "persist:paseo-browser"
    : `persist:paseo-browser-profile-${profileId}`;
}

export function normalizeBrowserProfileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_PROFILE_NAME_LENGTH ? name : null;
}

function toBrowserProfile(profile: Omit<BrowserProfile, "partition">): BrowserProfile {
  return { ...profile, partition: browserProfilePartition(profile.id) };
}

function defaultProfile(): BrowserProfile {
  return toBrowserProfile({
    id: DEFAULT_BROWSER_PROFILE_ID,
    name: DEFAULT_BROWSER_PROFILE_NAME,
    createdAt: 0,
  });
}

function normalizeDocument(value: unknown): { document: StoredDocument; repaired: boolean } {
  const sourceProfiles =
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "profiles" in value &&
    Array.isArray(value.profiles)
      ? value.profiles
      : [];
  const parsedDocument = StoredDocumentSchema.safeParse(value);
  let repaired =
    !parsedDocument.success || JSON.stringify(parsedDocument.data) !== JSON.stringify(value);
  const ids = new Set<string>();
  const names = new Set<string>();
  const profiles: StoredDocument["profiles"] = [];
  for (const candidate of sourceProfiles) {
    const parsed = StoredProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      repaired = true;
      continue;
    }
    const name = parsed.data.name.toLocaleLowerCase();
    if (ids.has(parsed.data.id) || names.has(name) || name === "default") {
      repaired = true;
      continue;
    }
    ids.add(parsed.data.id);
    names.add(name);
    profiles.push(parsed.data);
  }
  if (profiles.length !== sourceProfiles.length) repaired = true;
  return { document: { version: 1, profiles }, repaired };
}

export function createBrowserProfilesStore(input: {
  userDataPath: string;
  removePartitionData?: (profileId: string) => Promise<void>;
  createId?: () => string;
  now?: () => number;
}): BrowserProfilesStore {
  const filePath = path.join(input.userDataPath, BROWSER_PROFILES_FILENAME);
  let cached: StoredDocument | null = null;
  let operationQueue: Promise<unknown> = Promise.resolve();

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operationQueue.then(operation, operation);
    operationQueue = pending.catch(() => undefined);
    return pending;
  }

  async function persist(document: StoredDocument): Promise<void> {
    await mkdir(input.userDataPath, { recursive: true });
    const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporaryPath, filePath);
    cached = document;
  }

  async function load(): Promise<StoredDocument> {
    if (cached) return cached;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      cached = { version: 1, profiles: [] };
      await persist(cached);
      return cached;
    }
    let normalized: { document: StoredDocument; repaired: boolean };
    try {
      normalized = normalizeDocument(JSON.parse(raw));
    } catch {
      normalized = { document: { version: 1, profiles: [] }, repaired: true };
    }
    cached = normalized.document;
    if (normalized.repaired) {
      const backupPath = `${filePath}.corrupt.${Date.now()}`;
      await rename(filePath, backupPath);
      await persist(cached);
    }
    return cached;
  }

  return {
    list: () =>
      serialized(async () => [defaultProfile(), ...(await load()).profiles.map(toBrowserProfile)]),
    create: (value) =>
      serialized(async () => {
        const name = normalizeBrowserProfileName(value);
        if (!name || name.toLocaleLowerCase() === "default") {
          throw new Error("Browser profile name must be 1-80 characters and cannot be Default");
        }
        const document = await load();
        if (
          document.profiles.some(
            (profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          )
        ) {
          throw new Error(`Browser profile already exists: ${name}`);
        }
        const id = input.createId?.() ?? randomUUID();
        if (!PROFILE_ID_PATTERN.test(id))
          throw new Error("Browser profile id generator returned an invalid id");
        const profile = { id, name, createdAt: input.now?.() ?? Date.now() };
        await persist({ ...document, profiles: [...document.profiles, profile] });
        return toBrowserProfile(profile);
      }),
    delete: (value) =>
      serialized(async () => {
        if (typeof value !== "string" || value === DEFAULT_BROWSER_PROFILE_ID) return false;
        const document = await load();
        if (!document.profiles.some((profile) => profile.id === value)) return false;
        await input.removePartitionData?.(value);
        await persist({
          ...document,
          profiles: document.profiles.filter((profile) => profile.id !== value),
        });
        return true;
      }),
    resolveId: (value) =>
      serialized(async () => {
        if (value === undefined || value === null || value === DEFAULT_BROWSER_PROFILE_ID)
          return DEFAULT_BROWSER_PROFILE_ID;
        if (typeof value !== "string") return null;
        const document = await load();
        return document.profiles.some((profile) => profile.id === value) ? value : null;
      }),
  };
}
