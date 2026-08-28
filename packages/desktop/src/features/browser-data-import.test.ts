import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClassicLevel } from "classic-level";
import { afterEach, describe, expect, test } from "vitest";
import {
  decryptChromiumCookie,
  domainIsAllowed,
  importBrowserData,
  listBrowserImportSources,
  normalizeBrowserImportRequest,
  normalizeImportDomains,
  sweepStaleBrowserImportDirectories,
  type BrowserImportCookie,
  type BrowserOriginStorageRecord,
} from "./browser-data-import.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-import-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function encryptCookie(value: string, secret: string): Buffer {
  const key = pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
}

function encodeStorageString(value: string): Buffer {
  return Buffer.concat([Buffer.from([1]), Buffer.from(value, "latin1")]);
}

async function writeLevelFixture(
  directory: string,
  entries: Array<[Buffer | string, Buffer | string]>,
): Promise<void> {
  const database = new ClassicLevel<Buffer, Buffer>(directory, {
    keyEncoding: "buffer",
    valueEncoding: "buffer",
  });
  await database.open();
  await database.batch(
    entries.map(([key, value]) => ({
      type: "put" as const,
      key: Buffer.isBuffer(key) ? key : Buffer.from(key),
      value: Buffer.isBuffer(value) ? value : Buffer.from(value),
    })),
  );
  await database.close();
}

async function createChromeFixture(home: string, secret: string): Promise<string> {
  const profile = path.join(home, "Library/Application Support/Google/Chrome/Default");
  await mkdir(path.join(profile, "Network"), { recursive: true });
  await writeFile(
    path.join(home, "Library/Application Support/Google/Chrome/Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } } }),
  );
  const database = new DatabaseSync(path.join(profile, "Network/Cookies"));
  database.exec(`
    CREATE TABLE meta (key TEXT, value TEXT);
    INSERT INTO meta VALUES ('version', '23');
    CREATE TABLE cookies (
      host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
      samesite INTEGER, is_persistent INTEGER
    );
  `);
  const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(
    ".example.com",
    "session",
    "",
    encryptCookie("secret-cookie-value", secret),
    "/account",
    13_400_000_000_000_000,
    1,
    1,
    2,
    1,
  );
  insert.run("outside.test", "outside", "plain", Buffer.alloc(0), "/", 0, 0, 0, -1, 0);
  insert.run("example.com", "host-only", "plain-host", Buffer.alloc(0), "/", 0, 0, 0, 0, 0);
  database.close();

  await writeLevelFixture(path.join(profile, "Local Storage/leveldb"), [
    [
      Buffer.concat([Buffer.from("_https://example.com\0"), encodeStorageString("theme")]),
      encodeStorageString("dark"),
    ],
    [
      Buffer.concat([Buffer.from("_https://outside.test\0"), encodeStorageString("outside")]),
      encodeStorageString("blocked"),
    ],
    [Buffer.from("UNKNOWN"), Buffer.from("unsupported")],
  ]);
  await writeLevelFixture(path.join(profile, "Session Storage"), [
    ["namespace-window-guid-https://example.com", "map-1"],
    ["map-map-1-csrf", "session-value"],
    ["map-map-1", "1"],
    ["namespace-other-guid-https://outside.test", "map-2"],
    ["map-map-2-outside", "blocked"],
    ["map-orphan-key", "unsupported"],
  ]);

  // These forbidden sources are unreadable. A successful import proves the importer never opens them.
  for (const forbidden of ["History", "places.sqlite"]) {
    const file = path.join(profile, forbidden);
    await writeFile(file, "must not be opened");
    await chmod(file, 0o000);
  }
  return profile;
}

describe("browser data import", () => {
  test("sweeps only stale browser import temporary directories", async () => {
    const temporaryRoot = await temporaryDirectory();
    const stale = path.join(temporaryRoot, "paseo-browser-import-stale");
    const current = path.join(temporaryRoot, "paseo-browser-import-current");
    const unrelated = path.join(temporaryRoot, "unrelated-stale");
    await Promise.all([mkdir(stale), mkdir(current), mkdir(unrelated)]);
    await Promise.all([utimes(stale, 1, 1), utimes(unrelated, 1, 1)]);

    await sweepStaleBrowserImportDirectories({
      temporaryRoot,
      now: 2 * 24 * 60 * 60 * 1_000,
      maximumAgeMs: 24 * 60 * 60 * 1_000,
    });

    expect(await readdir(temporaryRoot)).toEqual([
      "paseo-browser-import-current",
      "unrelated-stale",
    ]);
  });

  test("discovers installed Chromium-family profiles without exposing paths", async () => {
    const home = await temporaryDirectory();
    await mkdir(path.join(home, "Library/Application Support/Google/Chrome/Default"), {
      recursive: true,
    });
    await writeFile(
      path.join(home, "Library/Application Support/Google/Chrome/Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Work" } } } }),
    );

    const result = await listBrowserImportSources({ homeDirectory: home, platform: "darwin" });

    expect(result).toEqual({
      sources: [
        { id: "chrome", name: "Google Chrome", profiles: [{ id: "Default", name: "Work" }] },
      ],
      warnings: [],
    });
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("validates and normalizes consent fields before display or import", () => {
    expect(
      normalizeBrowserImportRequest({
        sourceBrowserId: " chrome ",
        sourceProfileId: " Default ",
        domains: [" Example.COM. "],
        categories: ["cookies", "sessionStorage"],
        confirmMerge: true,
      }),
    ).toEqual({
      sourceBrowserId: "chrome",
      sourceProfileId: "Default",
      domains: ["example.com"],
      categories: ["cookies", "sessionStorage"],
      confirmMerge: true,
    });
    expect(() =>
      normalizeBrowserImportRequest({
        sourceBrowserId: "chrome\nspoof",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies"],
        confirmMerge: false,
      }),
    ).toThrow("Invalid source browser");
    for (const spoofed of ["chrome\u2028spoof", "chrome\u202espoof", "chrome\u2066spoof"]) {
      expect(() =>
        normalizeBrowserImportRequest({
          sourceBrowserId: spoofed,
          sourceProfileId: "Default",
          domains: ["example.com"],
          categories: ["cookies"],
          confirmMerge: false,
        }),
      ).toThrow("Invalid source browser");
    }
  });

  test("normalizes and applies the domain allowlist", () => {
    expect(normalizeImportDomains([".Example.COM.", "app.example.com"])).toEqual([
      "example.com",
      "app.example.com",
    ]);
    expect(domainIsAllowed(".login.example.com", ["example.com"])).toBe(true);
    expect(domainIsAllowed("notexample.com", ["example.com"])).toBe(false);
    expect(() => normalizeImportDomains(["*.example.com"])).toThrow("Invalid import domain");
    expect(() => normalizeImportDomains(["com"])).toThrow("public suffix");
    expect(() => normalizeImportDomains(["co.uk"])).toThrow("public suffix");
    expect(normalizeImportDomains(["localhost", "127.0.0.1"])).toEqual(["localhost", "127.0.0.1"]);
  });

  test("imports cookie attributes into only the Default browser session and skips failures and forbidden files", async () => {
    const home = await temporaryDirectory();
    const tempRoot = await temporaryDirectory();
    const secret = "fixture-safe-storage-secret";
    const profilePath = await createChromeFixture(home, secret);
    const targetCookies: BrowserImportCookie[] = [];
    const otherCookies: BrowserImportCookie[] = [];

    const result = await importBrowserData({
      request: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies"],
        confirmMerge: false,
      },
      homeDirectory: home,
      platform: "darwin",
      temporaryRoot: tempRoot,
      readSecret: async () => secret,
      targetSession: {
        cookies: {
          get: async () => [],
          set: async (cookie) => {
            targetCookies.push(cookie);
          },
        },
      },
    });

    expect(result.counts.cookies).toEqual({ imported: 2, skipped: 1 });
    expect(targetCookies).toEqual([
      expect.objectContaining({
        url: "https://example.com/account",
        domain: ".example.com",
        path: "/account",
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        value: "secret-cookie-value",
      }),
      {
        url: "http://example.com/",
        name: "host-only",
        value: "plain-host",
        path: "/",
        secure: false,
        httpOnly: false,
        sameSite: "no_restriction",
      },
    ]);
    expect(otherCookies).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("secret-cookie-value");
    expect(await readdir(tempRoot)).toEqual([]);
    await chmod(path.join(profilePath, "History"), 0o600);
    await chmod(path.join(profilePath, "places.sqlite"), 0o600);
    expect(await readFile(path.join(profilePath, "History"), "utf8")).toBe("must not be opened");
  });

  test("restores known localStorage records and queues sessionStorage only for the Default browser session", async () => {
    const home = await temporaryDirectory();
    const tempRoot = await temporaryDirectory();
    await createChromeFixture(home, "secret");
    const localRecords: BrowserOriginStorageRecord[] = [];
    const sessionRecords: BrowserOriginStorageRecord[] = [];

    const result = await importBrowserData({
      request: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["localStorage", "sessionStorage"],
        confirmMerge: false,
      },
      homeDirectory: home,
      platform: "darwin",
      temporaryRoot: tempRoot,
      targetSession: { cookies: { get: async () => [], set: async () => {} } },
      injectLocalStorage: async (records) => {
        localRecords.push(...records);
        return { imported: records.length, skipped: 0 };
      },
      queueSessionStorage: async (records) => {
        sessionRecords.push(...records);
        return {
          imported: 0,
          queued: records.length,
          skipped: 0,
          warnings: ["sessionStorage queued for the next Default-session tab."],
        };
      },
    });

    expect(localRecords).toEqual([{ origin: "https://example.com", key: "theme", value: "dark" }]);
    expect(sessionRecords).toEqual([
      { origin: "https://example.com", key: "csrf", value: "session-value" },
    ]);
    expect(result.counts.localStorage).toEqual({ imported: 1, skipped: 2 });
    expect(result.counts.sessionStorage).toEqual({ imported: 0, queued: 1, skipped: 2 });
    expect(result.warnings).toContain("sessionStorage queued for the next Default-session tab.");
    expect(JSON.stringify(result)).not.toContain("dark");
    expect(JSON.stringify(result)).not.toContain("session-value");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("degrades cookie import when node:sqlite is unavailable at runtime", async () => {
    const home = await temporaryDirectory();
    const tempRoot = await temporaryDirectory();
    await createChromeFixture(home, "secret");

    const result = await importBrowserData({
      request: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies"],
        confirmMerge: false,
      },
      homeDirectory: home,
      platform: "darwin",
      temporaryRoot: tempRoot,
      targetSession: { cookies: { get: async () => [], set: async () => {} } },
      loadSqlite: async () => {
        throw new Error("module unavailable");
      },
    });

    expect(result.counts.cookies).toEqual({ imported: 0, skipped: 0 });
    expect(result.warnings).toEqual([
      "Cookie import is unavailable because this runtime cannot load node:sqlite.",
    ]);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("degrades selected storage imports when classic-level is unavailable at runtime", async () => {
    const home = await temporaryDirectory();
    const tempRoot = await temporaryDirectory();
    await createChromeFixture(home, "secret");
    let localStorageInjections = 0;
    let sessionStorageQueues = 0;

    const result = await importBrowserData({
      request: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["localStorage", "sessionStorage"],
        confirmMerge: false,
      },
      homeDirectory: home,
      platform: "darwin",
      temporaryRoot: tempRoot,
      targetSession: { cookies: { get: async () => [], set: async () => {} } },
      injectLocalStorage: async () => {
        localStorageInjections += 1;
        return { imported: 0, skipped: 0 };
      },
      queueSessionStorage: async () => {
        sessionStorageQueues += 1;
        return { imported: 0, skipped: 0 };
      },
      loadLevel: async () => {
        throw new Error("module unavailable");
      },
    });

    expect(localStorageInjections).toBe(0);
    expect(sessionStorageQueues).toBe(0);
    expect(result.warnings).toEqual([
      "localStorage import is unavailable because this runtime cannot load classic-level.",
      "sessionStorage import is unavailable because this runtime cannot load classic-level.",
    ]);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("rejects a non-empty target without explicit merge confirmation", async () => {
    const home = await temporaryDirectory();
    await createChromeFixture(home, "secret");
    await expect(
      importBrowserData({
        request: {
          sourceBrowserId: "chrome",
          sourceProfileId: "Default",
          domains: ["example.com"],
          categories: ["cookies"],
          confirmMerge: false,
        },
        homeDirectory: home,
        platform: "darwin",
        targetSession: { cookies: { get: async () => [{}], set: async () => {} } },
      }),
    ).rejects.toThrow("explicit merge confirmation");
  });

  test("does not retry a failed Keychain lookup during one import", async () => {
    const home = await temporaryDirectory();
    await createChromeFixture(home, "secret");
    let keychainReads = 0;

    const result = await importBrowserData({
      request: {
        sourceBrowserId: "chrome",
        sourceProfileId: "Default",
        domains: ["example.com"],
        categories: ["cookies"],
        confirmMerge: false,
      },
      homeDirectory: home,
      platform: "darwin",
      readSecret: async () => {
        keychainReads += 1;
        throw new Error("fixture-keychain-secret-error");
      },
      targetSession: { cookies: { get: async () => [], set: async () => {} } },
    });

    expect(keychainReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fixture-keychain-secret-error");
  });

  test("reports cookie decryption failures without exposing ciphertext or secrets", () => {
    expect(() =>
      decryptChromiumCookie(
        Buffer.from("v10-not-valid-ciphertext"),
        "keychain-secret",
        ".example.com",
        23,
      ),
    ).toThrow();
  });
});
