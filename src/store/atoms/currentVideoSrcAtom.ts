import { atom } from "jotai";

export const currentVideoSrcAtom = atom<
  Record<string, { url: string; signal: AbortSignal }>
>({});
