import { useEffect, useRef } from "react";

/** Mutations do not receive React Query's query AbortSignal. Own their lifetime. */
export const useInferenceCancellation = () => {
  const controllers = useRef(new Set<AbortController>());
  const cancel = () => {
    for (const controller of controllers.current) controller.abort();
    controllers.current.clear();
  };
  useEffect(
    () => () => {
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    },
    []
  );
  const run = async <T>(
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const result = await task(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } finally {
      controllers.current.delete(controller);
    }
  };
  return { run, cancel };
};
