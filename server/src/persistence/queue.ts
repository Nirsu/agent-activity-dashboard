/** Preserve event order and stop acknowledging writes after a persistence failure. */
export class PersistenceQueue {
  private pending: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly onError: () => void) {}

  get healthy(): boolean {
    return !this.failed;
  }

  enqueue(write: () => Promise<unknown>): void {
    this.pending = this.pending.then(async () => {
      if (this.failed) {
        return;
      }
      try {
        await write();
      } catch {
        this.failed = true;
        this.onError();
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failed) {
      throw Object.assign(new Error('Activity persistence is unavailable. Restart after restoring the database connection.'), { statusCode: 503 });
    }
  }
}
