import { describe, expect, it, vi } from "vitest";

import type { ExternalRenderJob } from "./externalRenderJobRepository";
import { ExternalRenderJobService } from "./externalRenderJobService";
import type { MediaRenderProvider } from "./mediaRenderProvider";
import { waitForExternalRender } from "./waitForExternalRender";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const input = {
  id: "same-job",
  projectId: "same-project",
  provider: "mock",
  endpoint: "model/video",
  kind: "video" as const,
  requestJson: { prompt: "frozen" },
  inputAssetIds: []
};
const setup = () => {
  let row: Record<string, unknown> = {
    ...input,
    status: "SUBMITTED",
    requestId: "accepted-id",
    keychainAccount: "original"
  };
  const jobs = {
    get: vi.fn(async () => structuredClone(row)),
    beginSubmission: vi.fn(async (job: Record<string, unknown>) => {
      row = { ...job, status: "SUBMITTING" };
    }),
    settleSubmission: vi.fn(
      async (_id: string, result: Record<string, unknown>) => {
        row = { ...row, ...result };
      }
    ),
    settleRemoteJob: vi.fn(
      async (_id: string, result: Record<string, unknown>) => {
        row = { ...row, ...result };
      }
    ),
    markCancellationRequested: vi.fn(),
    finishIngestion: vi.fn(async () => {
      row.status = "INGESTED";
    })
  };
  const submit = vi.fn(async () => "new-id");
  const upload = vi.fn(async () => "https://mock/upload");
  const provider = {
    prepareSubmission: vi.fn(async () => ({
      keychainAccount: "original",
      submit,
      upload
    })),
    refresh: vi
      .fn<MediaRenderProvider["refresh"]>()
      .mockResolvedValue({ status: "PENDING" }),
    cancel: vi
      .fn<MediaRenderProvider["cancel"]>()
      .mockResolvedValue("CANCELLED")
  };
  const assets = { input: vi.fn(), download: vi.fn(async () => []) };
  const service = new ExternalRenderJobService(
    jobs as never,
    new Map([["mock", provider as unknown as MediaRenderProvider]]),
    assets as never
  );
  return {
    service,
    jobs,
    provider,
    assets,
    submit,
    upload,
    row: () => row,
    replace: (status = "SUBMITTED") => {
      row = {
        ...input,
        status,
        requestId: "replacement-id",
        keychainAccount: "replacement"
      };
    }
  };
};

describe("external job library lifetime", () => {
  it.each(["accept", "reject"])(
    "does not settle an old submission into replacement IDs after a late %s",
    async (outcome) => {
      const test = setup();
      const response = deferred<string>();
      test.submit.mockReturnValueOnce(response.promise);
      const old = test.service.submit(input);
      const rejected = expect(old).rejects.toThrow();
      await vi.waitFor(() => expect(test.submit).toHaveBeenCalledTimes(1));
      expect(test.row().status).toBe("SUBMITTING");
      await test.service.suspend();
      test.replace();
      test.service.reset();
      if (outcome === "accept") response.resolve("old-accepted-id");
      else response.reject(new Error("late failure"));
      await rejected;
      expect(test.jobs.settleSubmission).not.toHaveBeenCalled();
      expect(test.row().requestId).toBe("replacement-id");
      expect(test.provider.cancel).not.toHaveBeenCalled();
    }
  );

  it("prevents teardown during provider readiness from starting an upload or submission", async () => {
    const test = setup();
    const ready =
      deferred<Awaited<ReturnType<typeof test.provider.prepareSubmission>>>();
    test.provider.prepareSubmission.mockReturnValueOnce(ready.promise);
    const old = test.service.submit(input);
    const rejected = expect(old).rejects.toThrow();
    await test.service.suspend();
    test.service.reset();
    ready.resolve({
      keychainAccount: "old",
      submit: test.submit,
      upload: test.upload
    });
    await rejected;
    expect(test.jobs.beginSubmission).not.toHaveBeenCalled();
    expect(test.submit).not.toHaveBeenCalled();
    expect(test.upload).not.toHaveBeenCalled();
  });

  it("suppresses a late refresh result for a reused accepted job ID", async () => {
    const test = setup();
    const response =
      deferred<Awaited<ReturnType<MediaRenderProvider["refresh"]>>>();
    test.provider.refresh.mockReturnValueOnce(response.promise);
    const old = test.service.refresh(input.id);
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.provider.refresh).toHaveBeenCalledTimes(1)
    );
    await test.service.suspend();
    test.replace();
    test.service.reset();
    response.resolve({
      status: "OUTPUT_READY",
      outputJson: { urls: ["https://mock/old.mp4"] }
    });
    await rejected;
    expect(test.jobs.settleRemoteJob).not.toHaveBeenCalled();
    expect(test.row().status).toBe("SUBMITTED");
    expect(test.provider.cancel).not.toHaveBeenCalled();
  });

  it("blocks polling helper's automatic remote cancellation on library teardown", async () => {
    const test = setup();
    const response =
      deferred<Awaited<ReturnType<MediaRenderProvider["refresh"]>>>();
    test.provider.refresh.mockImplementationOnce(
      async (_request, _kind, signal) => {
        signal!.addEventListener(
          "abort",
          () => response.reject(new Error("transport aborted")),
          { once: true }
        );
        return response.promise;
      }
    );
    const controller = new AbortController();
    const old = test.service
      .get(input.id)
      .then((job) =>
        waitForExternalRender(
          test.service,
          job!,
          controller.signal,
          async () => {}
        )
      );
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.provider.refresh).toHaveBeenCalledTimes(1)
    );
    // Application teardown stops job service before resetting/replacing the DB.
    await test.service.suspend();
    controller.abort();
    await rejected;
    expect(test.provider.cancel).not.toHaveBeenCalled();
    expect(test.jobs.markCancellationRequested).not.toHaveBeenCalled();
    expect(test.row().status).toBe("SUBMITTED");
  });

  it("preserves explicitly requested cancellation of an accepted job in a live session", async () => {
    const test = setup();
    const signal = AbortSignal.abort();
    await expect(
      waitForExternalRender(
        test.service,
        test.row() as unknown as ExternalRenderJob,
        signal,
        async () => {}
      )
    ).rejects.toThrow();
    expect(test.provider.cancel).toHaveBeenCalledTimes(1);
    expect(test.jobs.settleRemoteJob).toHaveBeenCalledWith(input.id, {
      status: "CANCELLED"
    });
  });

  it("drains media ingestion already issued, but suppresses completion on teardown", async () => {
    const test = setup();
    test.replace("OUTPUT_READY");
    test.row().outputJson = { urls: ["https://mock/output.mp4"] };
    const files = deferred<never[]>();
    test.assets.download.mockReturnValueOnce(files.promise);
    const old = test.service.ingest(input.id);
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.assets.download).toHaveBeenCalledTimes(1)
    );
    let drained = false;
    const suspension = test.service.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    files.resolve([]);
    await suspension;
    await rejected;
    expect(test.jobs.finishIngestion).not.toHaveBeenCalled();
    test.replace("OUTPUT_READY");
    test.row().outputJson = { urls: ["https://mock/new.mp4"] };
    test.service.reset();
    await test.service.ingest(input.id);
    expect(test.assets.download).toHaveBeenCalledTimes(2);
    expect(test.jobs.finishIngestion).toHaveBeenCalledTimes(1);
  });

  it("drains beginSubmission before replacement and cannot post afterwards", async () => {
    const test = setup();
    const write = deferred<void>();
    test.jobs.beginSubmission.mockReturnValueOnce(write.promise);
    const old = test.service.submit(input);
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.jobs.beginSubmission).toHaveBeenCalledTimes(1)
    );
    let drained = false;
    const suspension = test.service.suspend().then(() => {
      drained = true;
    });
    await flush();
    expect(drained).toBe(false);
    write.resolve();
    await suspension;
    await rejected;
    expect(test.submit).not.toHaveBeenCalled();
    expect(test.provider.cancel).not.toHaveBeenCalled();
  });
  it("cannot auto-cancel a replacement job after old polling ignores abort until reset", async () => {
    const test = setup();
    const response =
      deferred<Awaited<ReturnType<MediaRenderProvider["refresh"]>>>();
    test.provider.refresh.mockReturnValueOnce(response.promise);
    const controller = new AbortController();
    const old = waitForExternalRender(
      test.service,
      test.row() as unknown as ExternalRenderJob,
      controller.signal,
      async () => {}
    );
    const rejected = expect(old).rejects.toThrow();
    await vi.waitFor(() =>
      expect(test.provider.refresh).toHaveBeenCalledTimes(1)
    );
    await test.service.suspend();
    test.replace();
    test.service.reset();
    controller.abort();
    response.resolve({ status: "PENDING" });
    await rejected;
    expect(test.provider.cancel).not.toHaveBeenCalled();
    expect(test.row().requestId).toBe("replacement-id");
  });
});
