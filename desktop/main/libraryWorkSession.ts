import { AsyncLocalStorage } from "node:async_hooks";

type Session<State> = {
  lifetime: AbortController;
  state: State;
  operations: Set<Promise<unknown>>;
};

/** Library-owned async work. Context follows detached continuations as well as
 * awaited calls; a late callback cannot acquire the replacement library merely
 * because it uses the same service/repository instance and identifiers.
 *
 * Repository boundaries are drained in full (including multi-await media
 * ingestion). Provider inference is deliberately NOT a drained operation.
 */
export class LibraryWorkSession<State> {
  private readonly context = new AsyncLocalStorage<Session<State>>();
  private current: Session<State>;

  constructor(private readonly createState: () => State) {
    this.current = this.create();
  }

  private create(): Session<State> {
    return {
      lifetime: new AbortController(),
      state: this.createState(),
      operations: new Set()
    };
  }

  private get session(): Session<State> {
    return this.context.getStore() ?? this.current;
  }

  get state(): State {
    return this.session.state;
  }
  get signal(): AbortSignal {
    return this.session.lifetime.signal;
  }

  capture(): AbortSignal {
    const signal = this.signal;
    signal.throwIfAborted();
    return signal;
  }

  async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const session = this.session;
    session.lifetime.signal.throwIfAborted();
    return this.context.run(session, async () => {
      const result = await operation();
      session.lifetime.signal.throwIfAborted();
      return result;
    });
  }

  bind<Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>
  ): (...args: Args) => Promise<Result> {
    return (...args) => this.run(() => operation(...args));
  }

  async boundary<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.guard({ operation }).operation();
  }

  /** Guard every repository method before AND after its asynchronous work.
   * Calls use the original receiver, preserving internal repository invariants.
   * Use drain=false only for another lifecycle-owned service, never a repository.
   */
  guard<T extends object>(target: T, drain = true): T {
    return new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const session = this.session;
          session.lifetime.signal.throwIfAborted();
          return this.context.run(session, () => {
            const result: unknown = Reflect.apply(value, object, args);
            if (
              !result ||
              typeof (result as { then?: unknown }).then !== "function"
            ) {
              session.lifetime.signal.throwIfAborted();
              return result;
            }
            const operation = Promise.resolve(result);
            if (drain) session.operations.add(operation);
            return operation
              .then((value) => {
                session.lifetime.signal.throwIfAborted();
                return value;
              })
              .finally(() => {
                if (drain) session.operations.delete(operation);
              });
          });
        };
      }
    });
  }

  stop(): void {
    this.current.lifetime.abort();
  }

  async suspend(): Promise<void> {
    const session = this.current;
    this.stop();
    await Promise.allSettled(session.operations);
  }

  reset(): void {
    if (!this.current.lifetime.signal.aborted || this.current.operations.size)
      throw new Error("Suspend and drain library work before reset");
    this.current = this.create();
  }
}
