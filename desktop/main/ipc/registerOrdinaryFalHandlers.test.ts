import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

import type {
  OrdinaryFalJob,
  OrdinaryFalSubmitResult
} from "../../shared/ordinaryFal";

import {
  ordinaryFalChannels,
  registerOrdinaryFalHandlers
} from "./registerOrdinaryFalHandlers";

type Handler = (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: Handler) =>
      handlers.set(channel, handler)
  }
}));

const event = (url: string) =>
  ({ sender: { id: 1 }, senderFrame: { url } }) as IpcMainInvokeEvent;
const trusted = event("http://localhost:3000");
const input = { id: "fixture" };
const result: OrdinaryFalJob = {
  id: "fixture",
  projectId: "project",
  shotId: "shot",
  kind: "image-edit",
  model: "fal_nano_banana_2",
  status: "SUBMITTED",
  placement: "PENDING",
  assetIds: [],
  clipId: null,
  error: null
};
const ack: OrdinaryFalSubmitResult = { status: "job", job: result };

beforeEach(() => handlers.clear());

it("checks sender trust before handing the original account signal to main", async () => {
  const signal = new AbortController().signal;
  const capture = vi.fn(() => signal);
  const service = {
    submit: vi.fn(async () => ack),
    get: vi.fn(async () => result),
    list: vi.fn(async () => [result])
  };
  registerOrdinaryFalHandlers(service, capture);
  const submit = handlers.get(ordinaryFalChannels.submit)!;
  await expect(submit(event("https://example.invalid"), input)).rejects.toThrow(
    "untrusted renderer"
  );
  expect(capture).not.toHaveBeenCalled();
  expect(service.submit).not.toHaveBeenCalled();
  await expect(submit(trusted, input)).resolves.toEqual(ack);
  expect(capture).toHaveBeenCalledExactlyOnceWith(trusted.sender);
  expect(service.submit).toHaveBeenCalledExactlyOnceWith(input, signal);
});

it("does not return a late main result to a retired sender", async () => {
  const profile = new AbortController();
  let finish!: (value: OrdinaryFalJob) => void;
  const pending = new Promise<OrdinaryFalJob>((resolve) => {
    finish = resolve;
  });
  registerOrdinaryFalHandlers(
    { submit: async () => ack, get: () => pending, list: async () => [] },
    () => profile.signal
  );
  const operation = handlers.get(ordinaryFalChannels.get)!(trusted, input);
  profile.abort(new Error("retired sender"));
  await expect(operation).rejects.toThrow("retired sender");
  finish(result);
});

it("forwards a definite validation reply without conflating it with a lost IPC response", async () => {
  const rejected: OrdinaryFalSubmitResult = {
    status: "rejected",
    message: "Select an untrimmed clip"
  };
  const submit = vi
    .fn<() => Promise<OrdinaryFalSubmitResult>>()
    .mockResolvedValueOnce(rejected)
    .mockRejectedValueOnce(new Error("transport disconnected"));
  registerOrdinaryFalHandlers(
    { submit, get: async () => null, list: async () => [] },
    () => new AbortController().signal
  );
  const handler = handlers.get(ordinaryFalChannels.submit)!;
  await expect(handler(trusted, input)).resolves.toEqual(rejected);
  await expect(handler(trusted, input)).rejects.toThrow(
    "transport disconnected"
  );
});
