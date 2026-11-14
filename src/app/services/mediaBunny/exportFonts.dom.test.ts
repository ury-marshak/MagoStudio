import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { loadExportLatoFonts } from "./exportFonts";

const construct = vi.fn();
const load = vi.fn();
const add = vi.fn();
let descriptor: PropertyDescriptor | undefined;
const setMode = (mode: unknown) =>
  Object.defineProperty(window, "mago", {
    configurable: true,
    value: { account: { mode } }
  });
beforeEach(() => {
  vi.clearAllMocks();
  descriptor = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add, ready: Promise.resolve() }
  });
  vi.stubGlobal(
    "FontFace",
    class {
      constructor(...args: unknown[]) {
        construct(...args);
      }
      load() {
        load();
        return Promise.resolve(this);
      }
    }
  );
  setMode("offline");
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { mago?: unknown }).mago;
  if (descriptor) Object.defineProperty(document, "fonts", descriptor);
  else delete (document as { fonts?: unknown }).fonts;
});

it.each(["offline", "unchosen", undefined])(
  "uses available/system fonts without network font construction in mode %s",
  async (mode) => {
    setMode(mode);
    await loadExportLatoFonts(["400", "700"]);
    expect(construct).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  }
);
it.each(["cloud", "web"])(
  "preserves %s font loading for decorated exports",
  async (mode) => {
    if (mode === "web") delete (window as { mago?: unknown }).mago;
    else setMode(mode);
    await loadExportLatoFonts(["400", "700"]);
    expect(construct).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledTimes(2);
  }
);
it("font failure remains optional rather than disabling local export", async () => {
  setMode("cloud");
  load.mockImplementationOnce(() => {
    throw new Error("fixture font failure");
  });
  await expect(loadExportLatoFonts(["400"])).resolves.toBeUndefined();
  expect(add).not.toHaveBeenCalled();
});
