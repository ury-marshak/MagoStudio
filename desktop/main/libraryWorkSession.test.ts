import { describe, expect, it, vi } from "vitest";

import { LibraryWorkSession } from "./libraryWorkSession";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("library work session", () => {
  it("retains the old session through detached continuations with reused identifiers", async () => {
    const work = new LibraryWorkSession(() => new Map<string, number>());
    const inference = deferred<void>();
    const write = vi.fn(async (_id: string) => {});
    const repository = work.guard({ write });
    let late!: Promise<void>;
    await work.run(async () => {
      work.state.set("same-id", 1);
      late = inference.promise.then(async () => {
        await repository.write("same-id");
      });
    });
    const rejected = expect(late).rejects.toThrow();
    await work.suspend();
    work.reset();
    work.state.set("same-id", 2);
    inference.resolve();
    await rejected;
    expect(write).not.toHaveBeenCalled();
    expect(work.state.get("same-id")).toBe(2);
  });

  it("drains an issued multi-await repository operation, not provider inference", async () => {
    const work = new LibraryWorkSession(() => ({}));
    const db = deferred<void>();
    const repository = work.guard({
      write: async () => {
        await db.promise;
      }
    });
    const operation = work.run(async () => {
      await repository.write();
    });
    const rejected = expect(operation).rejects.toThrow();
    let drained = false;
    const suspend = work.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    expect(() => work.reset()).toThrow();
    db.resolve();
    await rejected;
    await suspend;
    expect(drained).toBe(true);
    work.reset();
    const provider = work.guard(
      { infer: () => new Promise<void>(() => {}) },
      false
    );
    void work.run(() => provider.infer());
    await work.suspend();
    work.reset();
  });

  it("checks queued callbacks before issuing a new boundary", async () => {
    const work = new LibraryWorkSession(() => ({}));
    const gate = deferred<void>();
    const operation = vi.fn(async () => {});
    const pending = work.run(async () => {
      await gate.promise;
      await work.boundary(operation);
    });
    const rejected = expect(pending).rejects.toThrow();
    await work.suspend();
    work.reset();
    gate.resolve();
    await rejected;
    expect(operation).not.toHaveBeenCalled();
  });

  it("preserves repository receivers and synchronous cancellation methods", async () => {
    const work = new LibraryWorkSession(() => ({}));
    const repository = {
      count: 0,
      increment() {
        this.count += 1;
        return this.count;
      }
    };
    const guarded = work.guard(repository);
    expect(guarded.increment()).toBe(1);
    expect(repository.count).toBe(1);
    await work.suspend();
    expect(() => guarded.increment()).toThrow();
    expect(repository.count).toBe(1);
  });

  it("does not let old cleanup mutate replacement session state", async () => {
    const work = new LibraryWorkSession(() => new Map<string, string>());
    const provider = deferred<void>();
    const old = work.run(async () => {
      work.state.set("same-id", "old");
      try {
        await provider.promise;
      } finally {
        work.state.delete("same-id");
      }
    });
    const rejected = expect(old).rejects.toThrow();
    await work.suspend();
    work.reset();
    work.state.set("same-id", "new");
    provider.resolve();
    await rejected;
    expect(work.state.get("same-id")).toBe("new");
  });
});
