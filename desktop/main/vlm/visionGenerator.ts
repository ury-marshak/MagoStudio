export interface VisionRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Encoded images in the order referenced by the prompt. */
  images?: Buffer[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export type VisionGenerator = (request: VisionRequest) => Promise<{
  text: string;
  model: string;
}>;
