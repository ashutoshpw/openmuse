import type { ModelDriver } from "@openmuse/provider-contracts";
import {
  createOpenAiCompatibleModelDriver,
  type OpenAiCompatibleDriverOptions,
} from "@openmuse/provider-model-openai-compatible";

export interface MetaModelDriverOptions extends Omit<
  OpenAiCompatibleDriverOptions,
  "providerId" | "displayName" | "defaultEndpoint" | "defaultModel"
> {
  defaultEndpoint?: string;
  defaultModel?: string;
}

/**
 * Meta Model API documents the base URL and Muse Spark models here:
 * https://ai.developer.meta.com/docs/overview
 * https://ai.developer.meta.com/docs/models
 * https://ai.developer.meta.com/docs/protocols/chat-completions
 */
export function createMetaModelDriver(options: MetaModelDriverOptions = {}): ModelDriver {
  return createOpenAiCompatibleModelDriver({
    ...options,
    providerId: "meta-llama",
    displayName: "Meta Muse model",
    defaultEndpoint: options.defaultEndpoint ?? "https://api.meta.ai/v1",
    defaultModel: options.defaultModel ?? "muse-spark-1.3",
  });
}
