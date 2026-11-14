import { Blob as NodeBlob } from "node:buffer";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { render } from "@testing-library/react";
import type { AxiosAdapter } from "axios";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { MagoDesktopApi } from "../../../desktop/shared/contracts";

// This executes renderer modules/effects and the actual preload -> trusted IPC
// -> application composition in one process. It is not a Chromium egress test.
const fixture = vi.hoisted(() => ({
  userData: "",
  handlers: new Map<string, (...args: any[]) => any>(),
  appListeners: new Map<string, () => void>(),
  rendererListeners: new Map<string, (...args: any[]) => void>(),
  windows: [] as any[],
  key: vi.fn(),
  forbidden: vi.fn(),
  png: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64"
  )
}));
vi.unmock("@platform/identity");
vi.mock("electron", () => {
  const protocol = {
    handle: vi.fn(),
    unhandle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn()
  };
  const session = { defaultSession: { protocol } };
  class BrowserWindow {
    static getAllWindows = () => fixture.windows;
    webContents = Object.assign(new EventEmitter(), {
      id: 1,
      isDestroyed: () => false,
      setWindowOpenHandler: vi.fn(),
      session: session.defaultSession,
      send: (channel: string, ...args: unknown[]) =>
        fixture.rendererListeners.get(channel)?.({}, ...args)
    });
    on = vi.fn();
    once = vi.fn();
    loadURL = vi.fn(async () => {});
    constructor(public options: unknown) {
      fixture.windows.push(this);
    }
  }
  return {
    app: {
      isPackaged: false,
      getPath: () => fixture.userData,
      getAppPath: () => process.cwd(),
      getVersion: () => "fixture",
      commandLine: { appendSwitch: vi.fn() },
      setAsDefaultProtocolClient: vi.fn(),
      requestSingleInstanceLock: () => true,
      on: (name: string, callback: () => void) =>
        fixture.appListeners.set(name, callback),
      whenReady: async () => {},
      quit: fixture.forbidden,
      exit: fixture.forbidden
    },
    BrowserWindow,
    session,
    protocol,
    ipcMain: {
      handle: (name: string, handler: (...args: any[]) => any) =>
        fixture.handlers.set(name, handler),
      on: vi.fn(),
      removeHandler: vi.fn()
    },
    ipcRenderer: {
      invoke: async (name: string, ...args: unknown[]) => {
        const handler = fixture.handlers.get(name);
        if (!handler) throw new Error(`Unregistered IPC: ${name}`);
        return structuredClone(
          await handler(
            {
              sender: fixture.windows[0].webContents,
              senderFrame: { url: fixture.windows[0].loadURL.mock.calls[0][0] }
            },
            ...structuredClone(args)
          )
        );
      },
      on: (name: string, listener: (...args: any[]) => void) =>
        fixture.rendererListeners.set(name, listener),
      removeListener: (name: string) => fixture.rendererListeners.delete(name),
      send: vi.fn()
    },
    contextBridge: {
      exposeInMainWorld: (_name: string, api: MagoDesktopApi) => {
        window.mago = api;
      }
    },
    webUtils: {},
    net: { fetch: fixture.forbidden },
    dialog: {
      showMessageBox: fixture.forbidden,
      showMessageBoxSync: fixture.forbidden
    },
    shell: {
      openExternal: fixture.forbidden,
      showItemInFolder: fixture.forbidden
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 64, height: 48 })
      }),
      createFromBuffer: (bytes: Buffer) => ({
        isEmpty: () => false,
        getSize: () => ({ width: 64, height: 48 }),
        toPNG: () => bytes
      })
    }
  };
});
vi.mock("node:child_process", async (original) => {
  const child = await original<typeof import("node:child_process")>();
  const blocked = {
    exec: fixture.forbidden,
    execSync: fixture.forbidden,
    execFile: fixture.forbidden,
    execFileSync: fixture.forbidden,
    spawn: fixture.forbidden,
    spawnSync: fixture.forbidden,
    fork: fixture.forbidden
  };
  return { ...child, ...blocked, default: { ...child, ...blocked } };
});
vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  return {
    ...http,
    default: { ...http, request: fixture.forbidden, get: fixture.forbidden },
    request: fixture.forbidden,
    get: fixture.forbidden
  };
});
vi.mock("node:https", async (original) => {
  const https = await original<typeof import("node:https")>();
  return {
    ...https,
    default: { ...https, request: fixture.forbidden, get: fixture.forbidden },
    request: fixture.forbidden,
    get: fixture.forbidden
  };
});
// Native decoding/FFmpeg are fixture boundaries, not inference substitutes.
vi.mock("../../../desktop/main/media/imageThumbnail", () => ({
  createImageThumbnail: async (_source: string, destination: string) =>
    writeFile(destination, "fixture thumbnail")
}));
vi.mock("../../../desktop/main/cloud/probeRenderedVideoMetadata", () => ({
  probeRenderedVideoMetadata: async () => ({
    frameCount: 120,
    fps: 24,
    width: 64,
    height: 48
  })
}));
vi.mock("../../../desktop/main/media/doesVideoHaveAudioStream", () => ({
  doesVideoHaveAudioStream: async () => false
}));
vi.mock(
  "../../../desktop/main/scriptProjects/localScriptMedia",
  async (original) => ({
    ...(await original<
      typeof import("../../../desktop/main/scriptProjects/localScriptMedia")
    >()),
    extractFirstFrame: async () => fixture.png
  })
);
vi.mock("@clerk/react", () => ({ ClerkProvider: fixture.forbidden }));
vi.mock("@amplitude/analytics-browser", () => ({
  init: fixture.forbidden,
  track: fixture.forbidden,
  identify: fixture.forbidden
}));
vi.mock("@amplitude/plugin-session-replay-browser", () => ({
  sessionReplayPlugin: fixture.forbidden
}));
vi.mock("react-ga4", () => ({
  default: {
    initialize: fixture.forbidden,
    send: fixture.forbidden,
    event: fixture.forbidden
  }
}));
vi.mock("react-product-fruits", () => ({ ProductFruits: fixture.forbidden }));

type Row = Record<string, any>;
const textConfig = {
  baseUrl: "https://text.invalid/v1",
  model: "fixture-text",
  keychainAccount: "fixture-text-account"
};
const visionConfig = {
  baseUrl: "https://vision.invalid/v1",
  model: "fixture-vision",
  keychainAccount: "fixture-vision-account"
};
const profile = {
  text: textConfig,
  vision: visionConfig,
  fal: { keychainAccount: "fixture-fal-account" }
};
const storage =
  "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3";
const cdn = "https://v3.fal.media";
const queue = "https://queue.fal.run/";
const trace: Array<[string, string]> = [];
const submissions: Array<{ endpoint: string; id: string; body: Row }> = [];
const uploads: Array<{ name: string; upload_url: string; file_url: string }> =
  [];
let root: string;
let library: string;
let projectId: string;
let completion: string;
let providerStatus: number;
let falStatus: number;
let disconnected: boolean;
let view: ReturnType<typeof render> | undefined;
let backendTransport: ReturnType<typeof vi.fn<AxiosAdapter>>;
const nodeFetch = vi.fn<typeof fetch>();

const jsonBody = (options?: RequestInit): Row => {
  if (typeof options?.body !== "string")
    throw new Error("Expected JSON request body");
  return JSON.parse(options.body);
};

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.handlers.clear();
  fixture.appListeners.clear();
  fixture.rendererListeners.clear();
  fixture.windows.length = 0;
  trace.length = 0;
  submissions.length = 0;
  uploads.length = 0;
  completion = "";
  providerStatus = 200;
  falStatus = 200;
  disconnected = false;
  root = await mkdtemp(path.join(tmpdir(), "mago-combined-transport-"));
  fixture.userData = path.join(root, "profile");
  library = path.join(root, "library");
  await mkdir(fixture.userData);
  await writeFile(
    path.join(fixture.userData, "settings.json"),
    JSON.stringify({ libraryRoot: library })
  );
  await writeProfile(profile);
  fixture.forbidden.mockImplementation(() => {
    throw new Error(
      "Forbidden transport, SDK, child process or credential access"
    );
  });
  fixture.key.mockImplementation(async (account: string) => {
    if (
      ![
        textConfig.keychainAccount,
        visionConfig.keychainAccount,
        profile.fal.keychainAccount
      ].includes(account)
    )
      throw new Error("Unexpected fixture account");
    return "fixture-not-a-usable-key";
  });
  nodeFetch.mockImplementation(async (target, options) => {
    const url =
      typeof target === "string"
        ? target
        : target instanceof URL
          ? target.href
          : target.url;
    const method = options?.method ?? "GET";
    trace.push([method, url]);
    if (
      url === `${textConfig.baseUrl}/chat/completions` ||
      url === `${visionConfig.baseUrl}/chat/completions`
    ) {
      if (method !== "POST") throw new Error("Unexpected inference method");
      const body = jsonBody(options);
      expect(body.model).toBe(
        url.includes("text.invalid") ? textConfig.model : visionConfig.model
      );
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        "Bearer fixture-not-a-usable-key"
      );
      if (providerStatus === -1)
        throw new Error("Fixture provider disconnected");
      if (providerStatus !== 200)
        return new Response(null, { status: providerStatus });
      return Response.json({
        model: body.model,
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: url.includes("vision.invalid")
                ? "A blue mug on a wooden table."
                : completion
            }
          }
        ]
      });
    }
    if (url === storage && method === "POST") {
      const name = jsonBody(options).file_name;
      const id = `fixture-upload-${uploads.length + 1}`;
      const uploaded = {
        name,
        upload_url: `${cdn}/upload/${id}`,
        file_url: `${cdn}/input/${id}`
      };
      uploads.push(uploaded);
      return Response.json(uploaded);
    }
    if (
      uploads.some((upload) => url === upload.upload_url) &&
      method === "PUT"
    ) {
      expect(options?.body).toBeInstanceOf(NodeBlob);
      expect((options!.body as Blob).size).toBeGreaterThan(0);
      return new Response(null);
    }
    if (url.startsWith(queue) && method === "POST") {
      const endpoint = url.slice(queue.length);
      if (
        ![
          "minimax/h3-image/text-to-image",
          "minimax/h3-image/edit",
          "minimax/h3-max/reference-to-video"
        ].includes(endpoint)
      )
        throw new Error(`Unexpected endpoint ${endpoint}`);
      if (falStatus !== 200) return new Response(null, { status: falStatus });
      const id = `fixture-${submissions.length + 1}`;
      submissions.push({ endpoint, id, body: jsonBody(options) });
      return Response.json({ request_id: id, status: "IN_QUEUE" });
    }
    for (const job of submissions) {
      const base = `${queue}${job.endpoint.split("/").slice(0, 2).join("/")}/requests/${job.id}`;
      if (url === `${base}/status` && method === "GET") {
        if (disconnected)
          throw new Error("fixture disconnected after acceptance");
        return Response.json({ status: "COMPLETED", request_id: job.id });
      }
      const video = job.endpoint.includes("h3-max");
      const output = `${cdn}/output/${job.id}.${video ? "mp4" : "png"}`;
      if (url === base && method === "GET")
        return Response.json(
          video ? { video: { url: output } } : { images: [{ url: output }] }
        );
      if (url === output && method === "GET")
        return new Response(new Uint8Array(fixture.png));
    }
    fixture.forbidden(`Unexpected Node fetch ${method} ${url}`);
    throw new Error("Unreachable");
  });
  vi.stubGlobal("fetch", nodeFetch);
  // jsdom's Blob is not Node's upload/file Blob.
  vi.stubGlobal("Blob", NodeBlob);
  // In this combined jsdom fixture, window.fetch and Node global fetch share
  // the same strict recorder. Axios/XHR and SDK entry points are trapped too.
  backendTransport = vi.fn<AxiosAdapter>(() => fixture.forbidden());
  vi.stubGlobal("WebSocket", fixture.forbidden);
  vi.spyOn(XMLHttpRequest.prototype, "open").mockImplementation(
    fixture.forbidden
  );
  vi.stubEnv("MAGO_PACKAGED_SMOKE", "1");
  vi.stubEnv("MAGO_RENDERER_URL", "");
  vi.stubEnv("NEXT_PUBLIC_MAGO_STUDIO", "true");
  vi.stubEnv(
    "MAGO_MIGRATIONS_PATH",
    path.join(process.cwd(), "desktop/main/database/migrations")
  );
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  fixture.appListeners.get("before-quit")?.();
  Reflect.deleteProperty(window, "mago");
  process.argv = process.argv.filter(
    (arg) => !arg.startsWith("--mago-app-mode=")
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  expect(fixture.forbidden).not.toHaveBeenCalled();
  expect(backendTransport).not.toHaveBeenCalled();
});
const writeProfile = (value: unknown) =>
  writeFile(
    path.join(fixture.userData, "external-providers.json"),
    JSON.stringify(value)
  );
const start = async () => {
  // Replace only the OS reader; settings/routing/transport stay real.
  vi.spyOn(
    await import("../../../desktop/main/providers/externalProviderSettings"),
    "readExternalProviderKey"
  ).mockImplementation(fixture.key);
  const { ImageRenderService } =
    await import("../../../desktop/main/imageRenders/imageRenderService");
  const started = vi.spyOn(ImageRenderService.prototype, "start");
  // Main is compiled separately with the desktop ES2022 target, not the
  // renderer's ES2017 target. Load this cross-target composition at runtime.
  const mainModule = "../../../desktop/main/application.ts";
  await import(mainModule);
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(fixture.windows[0].options.webPreferences.additionalArguments).toEqual(
    ["--mago-app-mode=offline"]
  );
  process.argv.push(
    ...fixture.windows[0].options.webPreferences.additionalArguments
  );
  await import("../../../desktop/preload/preload");
  expect(window.mago?.account.mode).toBe("offline");
  const axios = (await import("axios")).default;
  axios.defaults.adapter = backendTransport;
  const { backendApiClient } = await import("@/lib/backend-api-client");
  backendApiClient.defaults.adapter = backendTransport;
  const { identityMode } = await import("@/platform/identity");
  expect(identityMode).toBe("offline");
  const { default: Providers } = await import("@app/providers");
  const { default: AuthenticatedLayout } =
    await import("@app/(authenticated)/layout");
  const { useCloudProjectSync } =
    await import("@/domains/scriptProject/useCloudProjectSync");
  function BackgroundRoutes() {
    useCloudProjectSync();
    return null;
  }
  view = render(
    <Providers>
      <AuthenticatedLayout>
        <BackgroundRoutes />
      </AuthenticatedLayout>
    </Providers>
  );
  const project = await window.mago!.projects.create({
    name: "Transport fixture",
    description: "",
    settings: { type: "script_to_shots" }
  });
  projectId = project.id;
  const { trackingUtils } = await import("@/app/hooks/tracking/trackingUtils");
  trackingUtils.projectActions.create(project.id, project.name);
  expect(trace).toEqual([]);
  expect(fixture.key).not.toHaveBeenCalled();
};
const waitPlan = async (id: string, status = "COMPLETED") => {
  await vi.waitFor(
    async () => {
      const plan = await window.mago!.scriptProjects.getPlan(id);
      expect(plan, JSON.stringify(plan)).toMatchObject({ status });
    },
    { timeout: 10000, interval: 20 }
  );
  return (await window.mago!.scriptProjects.getPlan(id))! as Row;
};
const chat = async () => {
  const { postScriptChatMessage } =
    await import("@/domains/scriptProject/api/postScriptChatMessage");
  const { getScriptChatMessages } =
    await import("@/domains/scriptProject/api/getScriptChatMessages");
  const accepted = await postScriptChatMessage({
    project_id: projectId,
    message: "A blue mug idea",
    system_prompt: "Reply with the reply tool.",
    tools: [
      {
        function_declarations: [
          {
            name: "reply",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"]
            }
          }
        ]
      }
    ]
  });
  await vi.waitFor(async () =>
    expect((await getScriptChatMessages(projectId)).pending).toBe(false)
  );
  return (await getScriptChatMessages(projectId)).messages.find(
    (message) => message.id === accepted.message_id
  )!;
};

it("traces local chat/casting, fal reference/storyboard and prepared shot submission/recovery across renderer/preload/main", async () => {
  await start();
  completion = JSON.stringify({
    function_call: { name: "reply", args: { message: "A mug in a studio." } }
  });
  expect(await chat()).toMatchObject({ status: "COMPLETED" });
  completion = JSON.stringify({
    title: "Mug",
    sequences: [
      {
        id: 1,
        heading: "INT. STUDIO - DAY",
        int_ext: "INT",
        time_of_day: "DAY"
      }
    ],
    sequence_video_prompts: [
      {
        id: 1,
        video_prompt: "A blue mug rests on a table.",
        needs_previous_frame: false
      }
    ],
    characters: [],
    environments: [],
    props: [
      {
        name: "Mug",
        description: "A blue ceramic mug",
        sequence_ids: [1],
        alt: "default",
        t2i_prompt: "A blue ceramic mug"
      }
    ]
  });
  const { postProjectScript } =
    await import("@/domains/scriptProject/api/postProjectScript");
  const cast = await postProjectScript({
    projectId,
    script: "INT. STUDIO - DAY\nA blue mug rests on a table.",
    isAtomicShotsRequested: false,
    maxShots: 1
  });
  await waitPlan(cast.plan_id);
  const snapshot = await window.mago!.scriptProjects.get(projectId);
  expect(snapshot?.state?.keys).toHaveLength(1);
  const { postGenerateProjectSheets } =
    await import("@/domains/scriptProject/api/postGenerateProjectSheets");
  const sheets = await postGenerateProjectSheets({
    projectId,
    isDryRun: false,
    settings: { render_model: "fal_minimax_h3_image" }
  });
  expect(sheets.plan_id, JSON.stringify(sheets)).toBeTypeOf("string");
  await waitPlan(sheets.plan_id!);
  const state = (await window.mago!.scriptProjects.get(projectId))!.state!;
  const scene = (state.shots as Row[])[0]!;
  const { patchProjectShot } =
    await import("@/domains/scriptProject/api/patchProjectShot");
  await patchProjectShot({
    projectId,
    timelineId: scene.timeline_id,
    durationSeconds: 5
  });
  const { postSceneStoryboardGenerate } =
    await import("@/domains/scriptProject/api/postSceneStoryboardGenerate");
  const board = await postSceneStoryboardGenerate({
    projectId,
    sceneTimelineId: scene.timeline_id,
    renderModel: "fal_minimax_h3_image"
  });
  expect(board.timeline_id).toBe(scene.timeline_id);
  const boardPlan = Object.values(
    (await window.mago!.scriptProjects.get(projectId))!.planDetails!
  ).find(
    (plan) => plan.id !== sheets.plan_id && plan.local_operation === "sheets"
  )!;
  await waitPlan(String(boardPlan.id));
  completion = JSON.stringify({
    subject_definitions: "{{ref:mug}} is the blue mug.",
    summary: "[reference generation] A blue mug on a table.",
    retention_analysis: "{{ref:mug}}: weak_reference - appearance.",
    detailed_description: "[Shot 1] The blue mug rests on the table.",
    overall_soundscape: "Room tone.",
    non_diegetic_music: "N/A"
  });
  disconnected = true;
  const { postGenerateProjectShots } =
    await import("@/domains/scriptProject/api/postGenerateProjectShots");
  const shots = await postGenerateProjectShots({
    projectId,
    isDryRun: false,
    timelineIds: [scene.timeline_id],
    videoSettings: {
      render_provider: "fal",
      provider_settings: { resolution: "480P" }
    }
  });
  const paused = await waitPlan(shots.plan_id!, "PAUSED");
  const submitted = (paused.steps as Row[]).find(
    (step) => step.tool_name === "submit_video_render"
  )!;
  expect(submitted.status).toBe("COMPLETED");
  expect(submissions.map((job) => job.endpoint)).toEqual([
    "minimax/h3-image/text-to-image",
    "minimax/h3-image/edit",
    "minimax/h3-max/reference-to-video"
  ]);
  expect(submissions[2].body).toMatchObject({
    duration: 5,
    resolution: "480P",
    reference_image_urls: [
      `${cdn}/input/fixture-upload-3`,
      `${cdn}/input/fixture-upload-4`
    ]
  });
  const preparation = structuredClone(
    paused.local_prepared_shots[scene.timeline_id]
  );
  expect(preparation).toMatchObject({
    version: 1,
    prompt: submissions[2].body.prompt
  });
  expect(submitted.local_preparation_digest).toBe(preparation.digest);
  const beforeRecovery = trace.slice();
  const keyReads = fixture.key.mock.calls.length;
  // Accepted recovery must not resolve/re-upload these now-missing inputs.
  await rm(path.join(library, "renders", "external"), {
    recursive: true,
    force: true
  });
  await rm(path.join(library, "script-projects"), {
    recursive: true,
    force: true
  });
  disconnected = false;
  await window.mago!.scriptProjects.resumePlan(shots.plan_id!);
  await waitPlan(shots.plan_id!);
  expect(submissions).toHaveLength(3);
  expect(
    trace.slice(beforeRecovery.length).every(([method]) => method === "GET")
  ).toBe(true);
  expect(fixture.key.mock.calls.slice(keyReads)).toEqual([
    [profile.fal.keychainAccount]
  ]);
  const finished = await window.mago!.scriptProjects.getPlan(shots.plan_id!);
  expect(finished!.local_prepared_shots).toEqual(paused.local_prepared_shots);
  const text = `${textConfig.baseUrl}/chat/completions`;
  const vision = `${visionConfig.baseUrl}/chat/completions`;
  const image = `${queue}minimax/h3-image`;
  const video = `${queue}minimax/h3-max`;
  // Exact ordered ledger: three text completions, one description, four typed
  // uploads, three submissions, one failed status and GET-only recovery.
  expect(trace).toEqual([
    ["POST", text],
    ["POST", text],
    ["POST", `${image}/text-to-image`],
    ["GET", `${image}/requests/fixture-1/status`],
    ["GET", `${image}/requests/fixture-1`],
    ["GET", `${cdn}/output/fixture-1.png`],
    ["POST", vision],
    ["POST", storage],
    ["PUT", `${cdn}/upload/fixture-upload-1`],
    ["POST", storage],
    ["PUT", `${cdn}/upload/fixture-upload-2`],
    ["POST", `${image}/edit`],
    ["GET", `${image}/requests/fixture-2/status`],
    ["GET", `${image}/requests/fixture-2`],
    ["GET", `${cdn}/output/fixture-2.png`],
    ["POST", text],
    ["POST", storage],
    ["PUT", `${cdn}/upload/fixture-upload-3`],
    ["POST", storage],
    ["PUT", `${cdn}/upload/fixture-upload-4`],
    ["POST", `${video}/reference-to-video`],
    ["GET", `${video}/requests/fixture-3/status`],
    ["GET", `${video}/requests/fixture-3/status`],
    ["GET", `${video}/requests/fixture-3`],
    ["GET", `${cdn}/output/fixture-3.mp4`]
  ]);
  expect(fixture.key.mock.calls).toEqual([
    [textConfig.keychainAccount],
    [textConfig.keychainAccount],
    [profile.fal.keychainAccount],
    [profile.fal.keychainAccount],
    [visionConfig.keychainAccount],
    [profile.fal.keychainAccount],
    [profile.fal.keychainAccount],
    [textConfig.keychainAccount],
    [profile.fal.keychainAccount],
    [profile.fal.keychainAccount],
    [profile.fal.keychainAccount]
  ]);
  const { DatabaseManager } =
    await import("../../../desktop/main/database/databaseManager");
  const { externalRenderJobs } =
    await import("../../../desktop/main/database/schema");
  const manager = new DatabaseManager();
  await manager.open(library);
  try {
    expect(
      (await manager.get().select().from(externalRenderJobs)).map(
        (job) => job.status
      )
    ).toEqual(["INGESTED", "INGESTED", "INGESTED"]);
    expect(await readFile(path.join(library, "mago.sqlite3"))).not.toHaveLength(
      0
    );
  } finally {
    manager.close();
  }
});

it.each([
  {
    name: "fal-only omission",
    metadata: { fal: profile.fal },
    status: 200,
    calls: 0
  },
  {
    name: "vision-only omission",
    metadata: { vision: visionConfig },
    status: 200,
    calls: 0
  },
  {
    name: "malformed text",
    metadata: { text: {}, fal: profile.fal },
    status: 200,
    calls: 0
  },
  {
    name: "HTTP unauthorized",
    metadata: { text: textConfig },
    status: 401,
    calls: 1
  },
  {
    name: "provider rate limit",
    metadata: { text: textConfig },
    status: 429,
    calls: 1
  },
  {
    name: "malformed completion envelope",
    metadata: { text: textConfig },
    status: 204,
    calls: 1
  }
])(
  "keeps renderer chat on the selected route without fallback: $name",
  async ({ metadata, status, calls }) => {
    await writeProfile(metadata);
    await start();
    providerStatus = status;
    const reply = await chat();
    expect(reply.status).toBe("FAILED");
    expect(trace).toEqual(
      Array.from({ length: calls }, () => [
        "POST",
        `${textConfig.baseUrl}/chat/completions`
      ])
    );
    expect(fixture.key.mock.calls).toEqual(
      Array.from({ length: calls }, () => [textConfig.keychainAccount])
    );
  }
);

it("requires an explicit cloud choice for a saved cloud-origin project's renderer action", async () => {
  await start();
  const { DatabaseManager } =
    await import("../../../desktop/main/database/databaseManager");
  const { projects } = await import("../../../desktop/main/database/schema");
  const manager = new DatabaseManager();
  await manager.open(library);
  try {
    await manager
      .get()
      .update(projects)
      .set({
        settingsJson: JSON.stringify({
          origin: "cloud",
          type: "script_to_shots"
        })
      });
  } finally {
    manager.close();
  }
  const { postScriptChatMessage } =
    await import("@/domains/scriptProject/api/postScriptChatMessage");
  await expect(
    postScriptChatMessage({
      project_id: projectId,
      message: "Do not send this to Mago",
      system_prompt: "",
      tools: []
    })
  ).rejects.toThrow("explicitly selected cloud account");
  expect(await window.mago!.projects.get(projectId)).toMatchObject({
    id: projectId,
    origin: "cloud",
    name: "Transport fixture"
  });
  expect(trace).toEqual([]);
  expect(fixture.key).not.toHaveBeenCalled();
});

it("fails closed on subsequently corrupted metadata through renderer chat", async () => {
  await start();
  await writeFile(
    path.join(fixture.userData, "external-providers.json"),
    "{invalid JSON"
  );
  expect(await chat()).toMatchObject({ status: "FAILED" });
  expect(trace).toEqual([]);
  expect(fixture.key).not.toHaveBeenCalled();
});

it.each(["network", "credential"])(
  "does not fall back after configured text %s failure",
  async (failure) => {
    await start();
    if (failure === "network") providerStatus = -1;
    else fixture.key.mockRejectedValue(new Error("Missing fixture credential"));
    expect(await chat()).toMatchObject({ status: "FAILED" });
    expect(trace).toEqual(
      failure === "network"
        ? [["POST", `${textConfig.baseUrl}/chat/completions`]]
        : []
    );
    expect(fixture.key.mock.calls).toEqual([[textConfig.keychainAccount]]);
  }
);

it.each([401, 429])(
  "does not retry or fall back from a fal HTTP %s rejection",
  async (status) => {
    await start();
    await window.mago!.scriptProjects.put({
      projectId,
      state: {
        keys: [
          {
            token: "mug",
            name: "Mug",
            kind: "prop",
            prompt: "A blue mug",
            enabled: true
          }
        ],
        shots: []
      }
    });
    falStatus = status;
    const { postGenerateProjectSheets } =
      await import("@/domains/scriptProject/api/postGenerateProjectSheets");
    const result = await postGenerateProjectSheets({
      projectId,
      isDryRun: false,
      settings: { render_model: "fal_minimax_h3_image" }
    });
    await waitPlan(result.plan_id!, "PAUSED");
    expect(trace).toEqual([["POST", `${queue}minimax/h3-image/text-to-image`]]);
    expect(submissions).toEqual([]);
    expect(uploads).toEqual([]);
    expect(fixture.key.mock.calls).toEqual([[profile.fal.keychainAccount]]);
  }
);
