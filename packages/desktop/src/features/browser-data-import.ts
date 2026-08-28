import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { ClassicLevel } from "classic-level";

export type BrowserImportCategory = "cookies" | "localStorage" | "sessionStorage";

export interface BrowserImportSourceProfile {
  id: string;
  name: string;
}

export interface BrowserImportSource {
  id: string;
  name: string;
  profiles: BrowserImportSourceProfile[];
}

export interface BrowserImportRequest {
  sourceBrowserId: string;
  sourceProfileId: string;
  domains: string[];
  categories: BrowserImportCategory[];
  confirmMerge: boolean;
}

function boundedDisplayString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`Invalid ${field}`);
  const normalized = value.trim();
  // eslint-disable-next-line no-control-regex -- Imported browser identifiers must reject ASCII control characters.
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
}

export function normalizeBrowserImportRequest(value: unknown): BrowserImportRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid browser import request");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.domains) || input.domains.length < 1 || input.domains.length > 100) {
    throw new Error("Invalid import domains");
  }
  if (
    !Array.isArray(input.categories) ||
    input.categories.length < 1 ||
    input.categories.length > 3
  ) {
    throw new Error("Invalid import categories");
  }
  const allowedCategories = new Set<BrowserImportCategory>([
    "cookies",
    "localStorage",
    "sessionStorage",
  ]);
  const categories = input.categories.map((category) => {
    if (typeof category !== "string" || !allowedCategories.has(category as BrowserImportCategory)) {
      throw new Error("Invalid import category");
    }
    return category as BrowserImportCategory;
  });
  if (new Set(categories).size !== categories.length) {
    throw new Error("Import categories must not contain duplicates");
  }
  if (input.confirmMerge !== true && input.confirmMerge !== false) {
    throw new Error("Invalid merge confirmation");
  }
  const rawDomains = input.domains.map((domain) =>
    boundedDisplayString(domain, "import domain", 253),
  );
  return {
    sourceBrowserId: boundedDisplayString(input.sourceBrowserId, "source browser", 80),
    sourceProfileId: boundedDisplayString(input.sourceProfileId, "source profile", 160),
    domains: normalizeImportDomains(rawDomains),
    categories,
    confirmMerge: input.confirmMerge,
  };
}

export interface BrowserImportCount {
  imported: number;
  skipped: number;
  queued?: number;
}

export interface BrowserImportResult {
  counts: Record<BrowserImportCategory, BrowserImportCount>;
  warnings: string[];
}

export interface BrowserOriginStorageRecord {
  origin: string;
  key: string;
  value: string;
}

export interface BrowserStorageImportOutcome extends BrowserImportCount {
  warnings?: string[];
}

export interface BrowserImportCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate?: number;
}

export interface BrowserImportTargetSession {
  storagePath?: string | null;
  cookies: {
    get(filter: Record<string, never>): Promise<unknown[]>;
    set(cookie: BrowserImportCookie): Promise<void>;
  };
}

interface SourceDefinition {
  id: string;
  name: string;
  relativePath: string;
  keychainService: string;
  keychainAccount: string;
}

const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    relativePath: "Library/Application Support/Google/Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
  },
  {
    id: "chromium",
    name: "Chromium",
    relativePath: "Library/Application Support/Chromium",
    keychainService: "Chromium Safe Storage",
    keychainAccount: "Chromium",
  },
  {
    id: "brave",
    name: "Brave",
    relativePath: "Library/Application Support/BraveSoftware/Brave-Browser",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    relativePath: "Library/Application Support/Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
  },
  {
    id: "arc",
    name: "Arc",
    relativePath: "Library/Application Support/Arc/User Data",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
  },
];

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  samesite: number | bigint;
  is_persistent: number | bigint;
}

interface SqliteRuntime {
  DatabaseSync: typeof DatabaseSync;
}

interface LevelRuntime {
  ClassicLevel: typeof ClassicLevel;
}

class BrowserImportRuntimeUnavailable extends Error {}

async function loadRuntime<Runtime>(loader: () => Promise<Runtime>): Promise<Runtime> {
  try {
    return await loader();
  } catch {
    throw new BrowserImportRuntimeUnavailable();
  }
}

async function loadSqliteRuntime(): Promise<SqliteRuntime> {
  // Keep optional runtime support out of Electron's main boot dependency graph.
  const sqliteSpecifier: string = "node:sqlite";
  return (await import(sqliteSpecifier)) as SqliteRuntime;
}

async function loadLevelRuntime(): Promise<LevelRuntime> {
  // classic-level loads a platform-native binding, so resolve it only for selected storage categories.
  const levelSpecifier: string = "classic-level";
  return (await import(levelSpecifier)) as LevelRuntime;
}

const execFileAsync = promisify(execFile);
const publicSuffixList = createRequire(__filename)("psl") as {
  get(hostname: string): string | null;
};
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;

function emptyCounts(): BrowserImportResult["counts"] {
  return {
    cookies: { imported: 0, skipped: 0 },
    localStorage: { imported: 0, skipped: 0 },
    sessionStorage: { imported: 0, skipped: 0 },
  };
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function normalizeProfileDirectory(value: string): string | null {
  if (value === "Default" || /^Profile \d+$/.test(value)) return value;
  return null;
}

export function normalizeImportDomains(values: readonly string[]): string[] {
  const domains = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
    if (!value || value.includes("/") || value.includes(":") || value.includes("*")) {
      throw new Error(`Invalid import domain: ${raw}`);
    }
    let hostname: string;
    try {
      hostname = new URL(`https://${value}`).hostname.toLowerCase();
    } catch {
      throw new Error(`Invalid import domain: ${raw}`);
    }
    if (!hostname || hostname !== value) throw new Error(`Invalid import domain: ${raw}`);
    const isLocalhost = hostname === "localhost" || hostname.endsWith(".localhost");
    if (!isLocalhost && isIP(hostname) === 0) {
      if (!publicSuffixList.get(hostname)) {
        throw new Error(`Import domain must not be a public suffix: ${raw}`);
      }
    }
    domains.add(hostname);
  }
  if (domains.size === 0) throw new Error("At least one import domain is required");
  return [...domains];
}

export function domainIsAllowed(hostname: string, domains: readonly string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/^\./, "");
  return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

async function readProfileNames(root: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const localState = JSON.parse(await readFile(path.join(root, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    for (const [directory, details] of Object.entries(localState.profile?.info_cache ?? {})) {
      const safeDirectory = normalizeProfileDirectory(directory);
      if (safeDirectory && typeof details.name === "string" && details.name.trim()) {
        names.set(safeDirectory, details.name.trim());
      }
    }
  } catch {
    // A missing or malformed Local State file does not make profile discovery unsafe.
  }
  return names;
}

export async function listBrowserImportSources(input?: {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
}): Promise<{ sources: BrowserImportSource[]; warnings: string[] }> {
  if ((input?.platform ?? process.platform) !== "darwin") {
    return { sources: [], warnings: ["Browser data import is currently supported on macOS only."] };
  }
  const homeDirectory = input?.homeDirectory ?? os.homedir();
  const sources: BrowserImportSource[] = [];
  for (const definition of SOURCE_DEFINITIONS) {
    const root = path.join(homeDirectory, definition.relativePath);
    if (!(await isDirectory(root))) continue;
    const names = await readProfileNames(root);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const profiles = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeProfileDirectory(entry.name))
      .filter((entry): entry is string => entry !== null)
      .sort((left, right) => {
        if (left === "Default") return -1;
        if (right === "Default") return 1;
        return left.localeCompare(right);
      })
      .map((directory) => ({
        id: directory,
        name: names.get(directory) ?? (directory === "Default" ? "Default" : directory),
      }));
    if (profiles.length > 0) sources.push({ id: definition.id, name: definition.name, profiles });
  }
  return { sources, warnings: [] };
}

async function readSafeStorageSecret(definition: SourceDefinition): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-w",
      "-s",
      definition.keychainService,
      "-a",
      definition.keychainAccount,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  const secret = stdout.replace(/[\r\n]+$/, "");
  if (!secret) throw new Error("Safe Storage secret was empty");
  return secret;
}

export function decryptChromiumCookie(
  encryptedValue: Uint8Array,
  secret: string,
  hostKey: string,
  databaseVersion: number,
): string {
  const buffer = Buffer.from(encryptedValue);
  if (
    buffer.length < 3 ||
    (buffer.subarray(0, 3).toString() !== "v10" && buffer.subarray(0, 3).toString() !== "v11")
  ) {
    throw new Error("Unsupported Chromium cookie encryption format");
  }
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  let plaintext = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);
  if (databaseVersion >= 24) {
    const digest = createHash("sha256").update(hostKey).digest();
    if (plaintext.length < digest.length || !plaintext.subarray(0, digest.length).equals(digest)) {
      throw new Error("Chromium cookie host digest did not match");
    }
    plaintext = plaintext.subarray(digest.length);
  }
  return plaintext.toString("utf8");
}

function chromeExpirationDate(value: number | bigint): number | undefined {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) return undefined;
  const unixSeconds = numericValue / 1_000_000 - CHROME_EPOCH_OFFSET_SECONDS;
  return unixSeconds > 0 ? unixSeconds : undefined;
}

function mapSameSite(value: number | bigint): BrowserImportCookie["sameSite"] {
  const numericValue = Number(value);
  if (numericValue === 1) return "lax";
  if (numericValue === 2) return "strict";
  if (numericValue === 0) return "no_restriction";
  return "unspecified";
}

async function snapshotCookieDatabase(
  source: string,
  temporaryDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const target = path.join(temporaryDirectory, "Cookies");
  await cp(source, target, { force: false });
  signal?.throwIfAborted();
  for (const suffix of ["-wal", "-shm"]) {
    signal?.throwIfAborted();
    await cp(`${source}${suffix}`, `${target}${suffix}`, { force: false }).catch((error) => {
      if (
        signal?.aborted ||
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  }
  signal?.throwIfAborted();
  return target;
}

async function snapshotLevelDatabase(
  source: string,
  temporaryDirectory: string,
  name: string,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (!(await isDirectory(source))) return null;
  const target = path.join(temporaryDirectory, name);
  await cp(source, target, { recursive: true, force: false });
  signal?.throwIfAborted();
  await rm(path.join(target, "LOCK"), { force: true });
  signal?.throwIfAborted();
  return target;
}

function parseStorageOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Chromium's DOM storage LevelDB serializer prefixes strings with 0 for UTF-16LE
// and 1 for Latin-1. Other encodings are intentionally not guessed.
export function decodeChromiumStorageString(value: Uint8Array): string | null {
  const buffer = Buffer.from(value);
  if (buffer.length === 0) return "";
  if (buffer[0] === 0) {
    const bytes = buffer.subarray(1);
    return bytes.length % 2 === 0 ? bytes.toString("utf16le") : null;
  }
  if (buffer[0] === 1) return buffer.subarray(1).toString("latin1");
  return null;
}

async function* iterateLevelEntries(
  databasePath: string,
  LevelDatabase: typeof ClassicLevel,
  signal?: AbortSignal,
): AsyncGenerator<[Buffer, Buffer]> {
  const database = new LevelDatabase<Buffer, Buffer>(databasePath, {
    createIfMissing: false,
    errorIfExists: false,
    keyEncoding: "buffer",
    valueEncoding: "buffer",
  });
  try {
    for await (const [key, value] of database.iterator()) {
      signal?.throwIfAborted();
      yield [Buffer.from(key), Buffer.from(value)];
    }
  } finally {
    await database.close();
  }
}

async function readChromiumLocalStorageDatabase(
  databasePath: string,
  domains: readonly string[],
  LevelDatabase: typeof ClassicLevel,
  signal?: AbortSignal,
): Promise<{ records: BrowserOriginStorageRecord[]; skipped: number; unknown: number }> {
  const aggregate = { records: [] as BrowserOriginStorageRecord[], skipped: 0, unknown: 0 };
  for await (const entry of iterateLevelEntries(databasePath, LevelDatabase, signal)) {
    const decoded = decodeChromiumLocalStorageEntries([entry], domains);
    aggregate.records.push(...decoded.records);
    aggregate.skipped += decoded.skipped;
    aggregate.unknown += decoded.unknown;
  }
  return aggregate;
}

async function readChromiumSessionStorageDatabase(
  databasePath: string,
  domains: readonly string[],
  LevelDatabase: typeof ClassicLevel,
  signal?: AbortSignal,
): Promise<{ records: BrowserOriginStorageRecord[]; skipped: number; unknown: number }> {
  const entries: Array<[Buffer, Buffer]> = [];
  for await (const entry of iterateLevelEntries(databasePath, LevelDatabase, signal))
    entries.push(entry);
  signal?.throwIfAborted();
  return decodeChromiumSessionStorageEntries(entries, domains);
}

export function decodeChromiumLocalStorageEntries(
  entries: readonly (readonly [Uint8Array, Uint8Array])[],
  domains: readonly string[],
): { records: BrowserOriginStorageRecord[]; skipped: number; unknown: number } {
  const records: BrowserOriginStorageRecord[] = [];
  let skipped = 0;
  let unknown = 0;
  for (const [rawKey, rawValue] of entries) {
    const key = Buffer.from(rawKey);
    if (key.subarray(0, 5).toString() === "META:" || key.toString() === "VERSION") continue;
    if (key[0] !== 0x5f) {
      unknown += 1;
      continue;
    }
    const separator = key.indexOf(0, 1);
    if (separator < 0) {
      unknown += 1;
      continue;
    }
    const parsedOrigin = parseStorageOrigin(key.subarray(1, separator).toString("utf8"));
    const storageKey = decodeChromiumStorageString(key.subarray(separator + 1));
    const storageValue = decodeChromiumStorageString(rawValue);
    if (!parsedOrigin || storageKey === null || storageValue === null) {
      unknown += 1;
      continue;
    }
    if (!domainIsAllowed(parsedOrigin.hostname, domains)) {
      skipped += 1;
      continue;
    }
    records.push({ origin: parsedOrigin.origin, key: storageKey, value: storageValue });
  }
  return { records, skipped, unknown };
}

function decodeUtf8(value: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

export function decodeChromiumSessionStorageEntries(
  entries: readonly (readonly [Uint8Array, Uint8Array])[],
  domains: readonly string[],
): { records: BrowserOriginStorageRecord[]; skipped: number; unknown: number } {
  const mapOrigins = new Map<string, string>();
  let unknown = 0;
  for (const [rawKey, rawValue] of entries) {
    const key = decodeUtf8(rawKey);
    if (!key?.startsWith("namespace-")) continue;
    const originOffset = key.indexOf("-http", "namespace-".length);
    const parsedOrigin = originOffset >= 0 ? parseStorageOrigin(key.slice(originOffset + 1)) : null;
    const mapId = decodeUtf8(rawValue);
    if (!parsedOrigin || !mapId || mapId.includes("\0")) {
      unknown += 1;
      continue;
    }
    mapOrigins.set(mapId, parsedOrigin.origin);
  }

  const records: BrowserOriginStorageRecord[] = [];
  let skipped = 0;
  for (const [rawKey, rawValue] of entries) {
    const key = Buffer.from(rawKey);
    if (!key.subarray(0, 4).equals(Buffer.from("map-"))) continue;
    let matched: { origin: string; keyOffset: number } | null = null;
    let isRefCount = false;
    for (const [mapId, origin] of mapOrigins) {
      const bareKey = Buffer.from(`map-${mapId}`);
      if (key.equals(bareKey)) {
        isRefCount = true;
        break;
      }
      const prefix = Buffer.from(`map-${mapId}-`);
      if (key.subarray(0, prefix.length).equals(prefix)) {
        matched = { origin, keyOffset: prefix.length };
        break;
      }
    }
    if (isRefCount) continue;
    if (!matched) {
      unknown += 1;
      continue;
    }
    const parsedOrigin = parseStorageOrigin(matched.origin);
    const storageKey = decodeUtf8(key.subarray(matched.keyOffset));
    const storageValue = decodeUtf8(rawValue);
    if (!parsedOrigin || storageKey === null || storageValue === null) {
      unknown += 1;
      continue;
    }
    if (!domainIsAllowed(parsedOrigin.hostname, domains)) {
      skipped += 1;
      continue;
    }
    records.push({ origin: parsedOrigin.origin, key: storageKey, value: storageValue });
  }
  return { records, skipped, unknown };
}

function resolveSourceProfile(input: { request: BrowserImportRequest; homeDirectory: string }): {
  definition: SourceDefinition;
  profilePath: string;
} {
  const definition = SOURCE_DEFINITIONS.find(
    (candidate) => candidate.id === input.request.sourceBrowserId,
  );
  if (!definition) throw new Error("Unknown browser import source");
  const profileDirectory = normalizeProfileDirectory(input.request.sourceProfileId);
  if (!profileDirectory) throw new Error("Unknown browser source profile");
  return {
    definition,
    profilePath: path.join(input.homeDirectory, definition.relativePath, profileDirectory),
  };
}

async function targetHasOriginStorage(targetSession: BrowserImportTargetSession): Promise<boolean> {
  const storagePath = targetSession.storagePath;
  if (!storagePath) return false;
  for (const relativePath of ["Local Storage/leveldb", "Session Storage"]) {
    const entries = await readdir(path.join(storagePath, relativePath)).catch(() => []);
    if (entries.length > 0) return true;
  }
  return false;
}

/* eslint-disable max-depth -- Category-specific import failures are isolated so one data type cannot abort the others. */
// eslint-disable-next-line complexity -- This is the transaction boundary for three independently selected categories.
export async function importBrowserData(input: {
  request: BrowserImportRequest;
  targetSession: BrowserImportTargetSession;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  readSecret?: (definition: SourceDefinition) => Promise<string>;
  injectLocalStorage?: (
    records: BrowserOriginStorageRecord[],
    signal?: AbortSignal,
  ) => Promise<BrowserStorageImportOutcome>;
  queueSessionStorage?: (
    records: BrowserOriginStorageRecord[],
  ) => Promise<BrowserStorageImportOutcome>;
  hasPendingSessionStorage?: () => boolean;
  temporaryRoot?: string;
  signal?: AbortSignal;
  loadSqlite?: () => Promise<SqliteRuntime>;
  loadLevel?: () => Promise<LevelRuntime>;
}): Promise<BrowserImportResult> {
  if ((input.platform ?? process.platform) !== "darwin") {
    throw new Error("Browser data import is currently supported on macOS only");
  }
  const domains = normalizeImportDomains(input.request.domains);
  const categories = new Set(input.request.categories);
  const targetSession = input.targetSession;
  const existingCookies = await targetSession.cookies.get({});
  if (
    (existingCookies.length > 0 ||
      (await targetHasOriginStorage(targetSession)) ||
      input.hasPendingSessionStorage?.()) &&
    !input.request.confirmMerge
  ) {
    throw new Error(
      "The Default browser session is not empty. Retry with explicit merge confirmation.",
    );
  }
  const { definition, profilePath } = resolveSourceProfile({
    request: input.request,
    homeDirectory: input.homeDirectory ?? os.homedir(),
  });
  if (!(await isDirectory(profilePath)))
    throw new Error("Browser source profile is no longer available");

  const result: BrowserImportResult = {
    counts: emptyCounts(),
    warnings: [],
  };
  const temporaryDirectory = await mkdtemp(
    path.join(input.temporaryRoot ?? os.tmpdir(), "paseo-browser-import-"),
  );
  try {
    input.signal?.throwIfAborted();

    if (categories.has("cookies")) {
      const cookiePath = path.join(profilePath, "Network", "Cookies");
      try {
        const snapshotPath = await snapshotCookieDatabase(
          cookiePath,
          temporaryDirectory,
          input.signal,
        );
        const sqlite = await loadRuntime(input.loadSqlite ?? loadSqliteRuntime);
        const database = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
        try {
          const databaseVersion = Number(
            (
              database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
                | { value?: unknown }
                | undefined
            )?.value ?? 0,
          );
          const cookieStatement = database.prepare(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies",
          );
          cookieStatement.setReadBigInts(true);
          let secretPromise: Promise<string> | null = null;
          for (const row of cookieStatement.iterate() as unknown as Iterable<CookieRow>) {
            input.signal?.throwIfAborted();
            if (!domainIsAllowed(row.host_key, domains)) {
              result.counts.cookies.skipped += 1;
              continue;
            }
            try {
              let value = row.value;
              if (!value && row.encrypted_value?.length) {
                secretPromise ??= (input.readSecret ?? readSafeStorageSecret)(definition);
                value = decryptChromiumCookie(
                  row.encrypted_value,
                  await secretPromise,
                  row.host_key,
                  databaseVersion,
                );
              }
              const hostname = row.host_key.replace(/^\./, "");
              await targetSession.cookies.set({
                url: `${row.is_secure ? "https" : "http"}://${hostname}${row.path || "/"}`,
                name: row.name,
                value,
                ...(row.host_key.startsWith(".") ? { domain: row.host_key } : {}),
                path: row.path || "/",
                secure: Boolean(row.is_secure),
                httpOnly: Boolean(row.is_httponly),
                sameSite: mapSameSite(row.samesite),
                ...(row.is_persistent && chromeExpirationDate(row.expires_utc)
                  ? { expirationDate: chromeExpirationDate(row.expires_utc) }
                  : {}),
              });
              result.counts.cookies.imported += 1;
            } catch {
              result.counts.cookies.skipped += 1;
            }
          }
        } finally {
          database.close();
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        result.warnings.push(
          error instanceof BrowserImportRuntimeUnavailable
            ? "Cookie import is unavailable because this runtime cannot load node:sqlite."
            : "The Chromium cookie database was unavailable or unsupported.",
        );
      }
      if (result.counts.cookies.skipped > 0) {
        result.warnings.push(
          `${result.counts.cookies.skipped} cookies were outside the allowlist, unsupported, or could not be decrypted.`,
        );
      }
    }

    if (categories.has("localStorage")) {
      const snapshotPath = await snapshotLevelDatabase(
        path.join(profilePath, "Local Storage", "leveldb"),
        temporaryDirectory,
        "Local Storage",
        input.signal,
      );
      if (!snapshotPath) {
        result.warnings.push("No Chromium localStorage database was found.");
      } else if (!input.injectLocalStorage) {
        result.warnings.push("This desktop host cannot inject localStorage.");
      } else {
        try {
          const level = await loadRuntime(input.loadLevel ?? loadLevelRuntime);
          const decoded = await readChromiumLocalStorageDatabase(
            snapshotPath,
            domains,
            level.ClassicLevel,
            input.signal,
          );
          const injected = await input.injectLocalStorage(decoded.records, input.signal);
          result.counts.localStorage = {
            imported: injected.imported,
            skipped: decoded.skipped + decoded.unknown + injected.skipped,
          };
          result.warnings.push(...(injected.warnings ?? []));
          if (decoded.unknown > 0) {
            result.warnings.push(
              `${decoded.unknown} localStorage records used an unsupported format and were skipped.`,
            );
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          result.warnings.push(
            error instanceof BrowserImportRuntimeUnavailable
              ? "localStorage import is unavailable because this runtime cannot load classic-level."
              : "The Chromium localStorage database was unreadable or unsupported.",
          );
        }
      }
    }

    if (categories.has("sessionStorage")) {
      const snapshotPath = await snapshotLevelDatabase(
        path.join(profilePath, "Session Storage"),
        temporaryDirectory,
        "Session Storage",
        input.signal,
      );
      if (!snapshotPath) {
        result.warnings.push("No Chromium sessionStorage database was found.");
      } else if (!input.queueSessionStorage) {
        result.warnings.push("This desktop host cannot restore sessionStorage.");
      } else {
        try {
          const level = await loadRuntime(input.loadLevel ?? loadLevelRuntime);
          const decoded = await readChromiumSessionStorageDatabase(
            snapshotPath,
            domains,
            level.ClassicLevel,
            input.signal,
          );
          const queued = await input.queueSessionStorage(decoded.records);
          result.counts.sessionStorage = {
            imported: queued.imported,
            queued: queued.queued ?? 0,
            skipped: decoded.skipped + decoded.unknown + queued.skipped,
          };
          result.warnings.push(...(queued.warnings ?? []));
          if (decoded.unknown > 0) {
            result.warnings.push(
              `${decoded.unknown} sessionStorage records used an unsupported format and were skipped.`,
            );
          }
        } catch (error) {
          if (input.signal?.aborted) throw error;
          result.warnings.push(
            error instanceof BrowserImportRuntimeUnavailable
              ? "sessionStorage import is unavailable because this runtime cannot load classic-level."
              : "The Chromium sessionStorage database was unreadable or unsupported.",
          );
        }
      }
    }
    return result;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
/* eslint-enable max-depth */
