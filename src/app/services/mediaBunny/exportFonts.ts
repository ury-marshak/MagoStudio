import { isCloudAccountActive } from "@/platform/cloudAccount";

const LATO_SOURCES: Record<string, string> = {
  "400": "https://fonts.gstatic.com/s/lato/v24/S6uyw4BMUTPHjx4wXiWtFCc.woff2",
  "700":
    "https://fonts.gstatic.com/s/lato/v24/S6u9w4BMUTPHh6UVSwiPGQ3q5d0.woff2"
};

/** Account-free exports use the already available Lato/system fallback. Fonts
 * are an optional decoration, never a prerequisite for local compositing. */
export const loadExportLatoFonts = async (
  weights: readonly string[]
): Promise<void> => {
  if (!isCloudAccountActive()) return;
  try {
    if (typeof FontFace === "undefined" || !document.fonts) return;
    const fonts = await Promise.all(
      weights.map((weight) =>
        new FontFace("Lato", `url(${LATO_SOURCES[weight]})`, {
          weight,
          style: "normal"
        }).load()
      )
    );
    if (!isCloudAccountActive()) return;
    for (const font of fonts) document.fonts.add(font);
    await document.fonts.ready;
  } catch (error) {
    console.warn(
      "Could not load Lato font, falling back to system font:",
      error
    );
  }
};
