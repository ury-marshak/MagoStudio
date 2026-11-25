import { addAbortListener } from "node:events";

/** Own the reader until EOF or until underlying transport cancellation settles. */
export const consumeProviderBody = async <T>(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>
): Promise<T> => {
  const reader = body.getReader();
  let ended = false;
  let closing: Promise<void> | undefined;
  const cancel = () => {
    if (!ended) closing ??= reader.cancel(signal.reason).catch(() => {});
  };
  const abort = addAbortListener(signal, cancel);
  const chunks = async function* () {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        ended = true;
        return;
      }
      yield chunk.value;
    }
  };
  try {
    signal.throwIfAborted();
    const result = await consume(chunks());
    signal.throwIfAborted();
    return result;
  } finally {
    abort[Symbol.dispose]();
    cancel();
    await closing;
    reader.releaseLock();
  }
};

const maxMetadataBytes = 1_048_576;

/** Small JSON metadata only, not media bodies. */
export const readProviderJson = async (
  response: Response,
  signal: AbortSignal
): Promise<unknown> => {
  if (!response.body) throw new Error("Provider response has no body");
  return consumeProviderBody(response.body, signal, async (chunks) => {
    const decoder = new TextDecoder();
    let text = "";
    let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > maxMetadataBytes)
        throw new Error("Provider metadata is too large");
      text += decoder.decode(chunk, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  });
};
