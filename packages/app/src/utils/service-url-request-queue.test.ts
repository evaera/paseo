import { afterEach, describe, expect, test, vi } from "vitest";
import { ServiceUrlRequestQueue } from "./service-url-request-queue";

afterEach(() => vi.useRealTimers());

describe("ServiceUrlRequestQueue", () => {
  test("runs every accepted URL in order", async () => {
    const queue = new ServiceUrlRequestQueue<string>(1_000, 3);
    const order: string[] = [];
    let finishFirst: (() => void) | undefined;
    const first = queue.enqueue("workspace", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      order.push("first:end");
      return "first";
    });
    const second = queue.enqueue("workspace", async () => {
      order.push("second");
      return "second";
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(order).toEqual(["first:start"]);
    if (!first || !second) throw new Error("Expected queued entries");
    finishFirst?.();
    await expect(first.completion).resolves.toBe("first");
    await expect(second.completion).resolves.toBe("second");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  test("timeout aborts the active entry and advances the queue", async () => {
    vi.useFakeTimers();
    const queue = new ServiceUrlRequestQueue<string>(100, 3);
    const first = queue.enqueue("workspace", async () => new Promise<string>(() => {}));
    const second = queue.enqueue("workspace", async () => "second");

    if (!first || !second) throw new Error("Expected queued entries");
    const firstRejected = expect(first.completion).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(100);
    await firstRejected;
    await expect(second.completion).resolves.toBe("second");
  });

  test("returns failure before acceptance when the workspace queue is full", () => {
    const queue = new ServiceUrlRequestQueue<string>(1_000, 2);
    const first = queue.enqueue("workspace", async () => new Promise<string>(() => {}));
    const second = queue.enqueue("workspace", async () => "second");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(queue.enqueue("workspace", async () => "third")).toBeNull();
    if (!first || !second) throw new Error("Expected queued entries");
    void first.completion.catch(() => {});
    void second.completion.catch(() => {});
    queue.dispose();
  });
});
