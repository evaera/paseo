export interface ServiceUrlQueueEntry<T> {
  completion: Promise<T>;
}

interface PendingEntry<T> {
  operation: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

interface WorkspaceQueue<T> {
  active: boolean;
  activeController: AbortController | null;
  pending: PendingEntry<T>[];
}

export class ServiceUrlRequestQueue<T> {
  private readonly queues = new Map<string, WorkspaceQueue<T>>();
  private disposed = false;

  public constructor(
    private readonly timeoutMs: number,
    private readonly maxEntriesPerWorkspace: number,
  ) {}

  public enqueue(
    workspaceKey: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): ServiceUrlQueueEntry<T> | null {
    if (this.disposed) return null;
    const queue = this.queues.get(workspaceKey) ?? {
      active: false,
      activeController: null,
      pending: [],
    };
    const size = queue.pending.length + Number(queue.active);
    if (size >= this.maxEntriesPerWorkspace) return null;

    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<T>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    queue.pending.push({ operation, resolve, reject });
    this.queues.set(workspaceKey, queue);
    this.pump(workspaceKey, queue);
    return { completion };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const queue of this.queues.values()) {
      queue.activeController?.abort(new Error("Desktop browser host disconnected."));
      for (const entry of queue.pending.splice(0)) {
        entry.reject(new Error("Desktop browser host disconnected."));
      }
    }
  }

  private pump(workspaceKey: string, queue: WorkspaceQueue<T>): void {
    if (this.disposed || queue.active) return;
    const entry = queue.pending.shift();
    if (!entry) {
      this.queues.delete(workspaceKey);
      return;
    }

    queue.active = true;
    const controller = new AbortController();
    queue.activeController = controller;
    const timeout = setTimeout(() => {
      controller.abort(new Error("Service URL choice timed out."));
    }, this.timeoutMs);

    void Promise.race([
      entry.operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      }),
    ])
      .then(entry.resolve, (error: unknown) =>
        entry.reject(error instanceof Error ? error : new Error("Service URL operation failed.")),
      )
      .finally(() => {
        clearTimeout(timeout);
        queue.active = false;
        queue.activeController = null;
        if (!this.disposed) this.pump(workspaceKey, queue);
      });
  }
}
