import { EventEmitter } from "node:events";

import { expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { extractStarterArchive } from "./extractStarterArchive";
import { runPythonProcess } from "./installNodePackRequirements";
import { SetupAttempt } from "./setupAttempt";

it.each([
  [
    "PowerShell",
    (signal: AbortSignal) =>
      extractStarterArchive("archive.zip", "staging", signal)
  ],
  [
    "pip",
    (signal: AbortSignal) => runPythonProcess("python", ["-m", "pip"], signal)
  ]
] as const)(
  "drains %s through child close, not error or exit",
  async (_name, command) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter()
    });
    spawn.mockReturnValueOnce(child);
    const profile = new AbortController();
    const attempt = new SetupAttempt(profile.signal);
    const issued = expect(
      attempt.issue<unknown>(() => command(attempt.signal))
    ).rejects.toThrow();
    await vi.waitFor(() =>
      expect(spawn).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ signal: attempt.signal })
      )
    );
    profile.abort();
    const drained = vi.fn();
    const barrier = attempt.drain().then(drained);
    child.emit("error", new Error("abort sent"));
    child.emit("exit", null, "SIGTERM");
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    child.emit("close", null, "SIGTERM");
    await issued;
    await barrier;
    expect(drained).toHaveBeenCalledOnce();
  }
);
