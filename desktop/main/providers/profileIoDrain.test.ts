import { expect, it, vi } from "vitest";

import { deferred } from "../localSetup/setupTestUtils";

import { ProfileIoDrain } from "./profileIoDrain";

it("enlists synchronous entry and drains only retired work through cleanup", async () => {
  const tracker = new ProfileIoDrain();
  const old = new AbortController();
  const current = new AbortController();
  const close = deferred<void>();
  const live = deferred<void>();
  const finished = vi.fn();
  let draining: Promise<void> | undefined;
  const active = tracker.run(current.signal, () => live.promise);
  const retiring = tracker.run(old.signal, () => {
    old.abort();
    draining = tracker.drainRetired().then(finished);
    return close.promise;
  });
  const notIssued = vi.fn(async () => {});
  await expect(tracker.run(old.signal, notIssued)).rejects.toMatchObject({
    name: "AbortError"
  });
  expect(notIssued).not.toHaveBeenCalled();
  expect(finished).not.toHaveBeenCalled();
  close.resolve();
  await draining;
  expect(finished).toHaveBeenCalledOnce();
  await retiring;
  live.resolve();
  await active;
});
