import type { z } from "zod";
import { env } from "../config/env.js";
import { invokeBailianModel } from "./client.js";
import { extractJsonObject } from "../shared/utils.js";

export async function invokeJsonModel<T>(
  schema: z.ZodType<T>,
  input: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const raw = await invokeBailianModel({
    model: input.model ?? env.BAILIAN_MODEL_ORCHESTRATOR,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    jsonMode: true,
    timeoutMs: input.timeoutMs,
  });

  const json = extractJsonObject(raw);
  return schema.parse(JSON.parse(json));
}
