/** Track issued local I/O and transport cleanup, never remote inference. */
export class ProfileIoDrain {
  private readonly issued = new Set<{
    profile: AbortSignal;
    pending: Promise<void>;
  }>();

  async run<T>(
    profile: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!profile) return operation();
    profile.throwIfAborted();
    // Enlist before invoking the operation: it may synchronously notify a
    // subscriber that retires the profile. Each invocation owns its own entry.
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const entry = { profile, pending: promise };
    this.issued.add(entry);
    try {
      return await operation();
    } finally {
      this.issued.delete(entry);
      resolve();
    }
  }

  async drainRetired(): Promise<void> {
    await Promise.all(
      [...this.issued].flatMap(({ pending, profile }) =>
        profile.aborted ? [pending] : []
      )
    );
  }
}
