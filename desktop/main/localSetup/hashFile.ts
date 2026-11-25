import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const hashFile = async (
  file: string,
  signal?: AbortSignal
): Promise<string> => {
  signal?.throwIfAborted();
  const hash = createHash("sha256");
  const source = createReadStream(file, { signal });
  const closed = new Promise<void>((resolve) => source.once("close", resolve));
  try {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    signal?.throwIfAborted();
    return hash.digest("hex");
  } finally {
    source.destroy();
    await closed;
  }
};
