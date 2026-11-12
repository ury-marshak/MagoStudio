export const magoState = {
  all: ["mago-state"] as const
};

export const version = {
  all: ["version"] as const
};

export const vlmStatus = {
  all: ["vlm-status"] as const
};

/** The desktop ComfyUI and text-model settings (`window.mago.comfy.get`). */
export const comfySettings = {
  all: ["comfy-settings"] as const
};

export const externalProviders = {
  configuredText: ["external-text-configured"] as const,
  capability: (capability: "text" | "vision" | "fal") =>
    ["external-provider-settings", capability] as const
};
