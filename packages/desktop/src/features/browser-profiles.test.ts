import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  browserProfilePartition,
  broadcastBrowserProfileEvent,
  createBrowserProfilesStore,
  DEFAULT_BROWSER_PROFILE_ID,
  deleteBrowserProfileWithConfirmation,
} from "./browser-profiles.js";

const directories = new Set<string>();

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-browser-profiles-"));
  directories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

describe("browser profile partitions", () => {
  test("keeps Default on the legacy partition and isolates named profiles", () => {
    expect(browserProfilePartition(DEFAULT_BROWSER_PROFILE_ID)).toBe("persist:paseo-browser");
    expect(browserProfilePartition("123e4567-e89b-42d3-a456-426614174000")).toBe(
      "persist:paseo-browser-profile-123e4567-e89b-42d3-a456-426614174000",
    );
  });
});

describe("browser profile events", () => {
  test("broadcasts profile changes to every renderer window", () => {
    const sent: Array<{ window: number; channel: string; payload: unknown }> = [];
    const windows = [1, 2].map((window) => ({
      webContents: {
        send(channel: string, payload: unknown): void {
          sent.push({ window, channel, payload });
        },
      },
    }));

    broadcastBrowserProfileEvent(windows, "browser-profile-deleting", { profileId: "profile-1" });

    expect(sent).toEqual([
      {
        window: 1,
        channel: "paseo:event:browser-profile-deleting",
        payload: { profileId: "profile-1" },
      },
      {
        window: 2,
        channel: "paseo:event:browser-profile-deleting",
        payload: { profileId: "profile-1" },
      },
    ]);
  });
});

describe("BrowserProfilesStore", () => {
  test("always lists Default first and persists named profiles", async () => {
    const userDataPath = await tempDirectory();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const store = createBrowserProfilesStore({ userDataPath, createId: () => id, now: () => 42 });

    expect(await store.list()).toMatchObject([{ id: "default", name: "Default", createdAt: 0 }]);
    await expect(store.create("  Work  ")).resolves.toMatchObject({
      id,
      name: "Work",
      createdAt: 42,
    });
    expect(await createBrowserProfilesStore({ userDataPath }).list()).toMatchObject([
      { id: "default", name: "Default", createdAt: 0 },
      { id, name: "Work", createdAt: 42 },
    ]);
    expect(
      JSON.parse(await readFile(path.join(userDataPath, "browser-profiles.json"), "utf8")),
    ).toEqual({
      version: 1,
      profiles: [{ id, name: "Work", createdAt: 42 }],
    });
  });

  test("protects Default, rejects duplicate names, and clears a named partition before deletion", async () => {
    const userDataPath = await tempDirectory();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const removed: string[] = [];
    const store = createBrowserProfilesStore({
      userDataPath,
      createId: () => id,
      removePartitionData: async (profileId) => {
        removed.push(profileId);
      },
    });

    await store.create("Personal");
    await expect(store.create("personal")).rejects.toThrow("already exists");
    await expect(store.delete("default")).resolves.toBe(false);
    await expect(store.delete(id)).resolves.toBe(true);
    expect(removed).toEqual([id]);
    expect(await store.list()).toHaveLength(1);
  });

  test("requires confirmation to delete a named profile and never confirms Default", async () => {
    const userDataPath = await tempDirectory();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const store = createBrowserProfilesStore({ userDataPath, createId: () => id });
    await store.create("Personal");
    const confirmations: string[] = [];

    await expect(
      deleteBrowserProfileWithConfirmation({
        store,
        profileId: "default",
        confirm: async (profile) => {
          confirmations.push(profile.id);
          return true;
        },
      }),
    ).resolves.toBe(false);
    await expect(
      deleteBrowserProfileWithConfirmation({
        store,
        profileId: id,
        confirm: async (profile) => {
          confirmations.push(profile.id);
          return false;
        },
      }),
    ).resolves.toBe(false);
    expect((await store.list()).map((profile) => profile.id)).toEqual(["default", id]);

    await expect(
      deleteBrowserProfileWithConfirmation({
        store,
        profileId: id,
        confirm: async (profile) => {
          confirmations.push(profile.id);
          return true;
        },
      }),
    ).resolves.toBe(true);
    expect(confirmations).toEqual([id, id]);
    expect((await store.list()).map((profile) => profile.id)).toEqual(["default"]);
  });

  test("serializes concurrent profile creation without losing updates", async () => {
    const userDataPath = await tempDirectory();
    const ids = ["123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-a456-426614174001"];
    const store = createBrowserProfilesStore({ userDataPath, createId: () => ids.shift()! });
    await Promise.all([store.create("Work"), store.create("Personal")]);
    expect((await store.list()).map((profile) => profile.name)).toEqual([
      "Default",
      "Work",
      "Personal",
    ]);
  });

  test("backs up corrupt metadata before creating a fresh document", async () => {
    const userDataPath = await tempDirectory();
    await writeFile(path.join(userDataPath, "browser-profiles.json"), "not json");
    const store = createBrowserProfilesStore({ userDataPath });
    expect(await store.list()).toMatchObject([{ id: "default", name: "Default" }]);
    const files = await readdir(userDataPath);
    expect(files.some((file) => file.startsWith("browser-profiles.json.corrupt."))).toBe(true);
  });

  test("salvages valid profiles and backs up a partially corrupt document", async () => {
    const userDataPath = await tempDirectory();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const filePath = path.join(userDataPath, "browser-profiles.json");
    const original = JSON.stringify({
      version: 1,
      profiles: [
        { id, name: "Work", createdAt: 42 },
        { id: "invalid", name: "Broken", createdAt: 43 },
      ],
    });
    await writeFile(filePath, original);

    expect(await createBrowserProfilesStore({ userDataPath }).list()).toMatchObject([
      { id: "default", name: "Default" },
      { id, name: "Work", createdAt: 42 },
    ]);
    const backup = (await readdir(userDataPath)).find((file) =>
      file.startsWith("browser-profiles.json.corrupt."),
    );
    expect(backup).toBeDefined();
    await expect(readFile(path.join(userDataPath, backup!), "utf8")).resolves.toBe(original);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 1,
      profiles: [{ id, name: "Work", createdAt: 42 }],
    });
  });

  test("only resolves ids owned by the desktop store", async () => {
    const userDataPath = await tempDirectory();
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const store = createBrowserProfilesStore({ userDataPath, createId: () => id });
    await store.create("Work");

    await expect(store.resolveId(undefined)).resolves.toBe("default");
    await expect(store.resolveId(id)).resolves.toBe(id);
    await expect(store.resolveId("123e4567-e89b-42d3-a456-426614174999")).resolves.toBeNull();
  });
});
