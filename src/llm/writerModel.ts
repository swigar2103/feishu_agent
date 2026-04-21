import { env } from "../config/env.js";
import {
  WriterOutputSchema,
  type ReviewIssue,
  type WriterInput,
  type WriterOutput,
} from "../schemas/index.js";
import { extractJsonObject } from "../shared/utils.js";
import { invokeBailianModel } from "./client.js";
import { buildWriterSystemPrompt, buildWriterUserPrompt } from "../prompts/writerPrompt.js";

export type WriterRevisionHints = {
  previousDraft: WriterOutput | null;
  issues: ReviewIssue[];
};

export async function generateWriterOutput(
  writerInput: WriterInput,
  revisionHints?: WriterRevisionHints,
): Promise<WriterOutput> {
  const raw = await invokeBailianModel({
    model: env.BAILIAN_MODEL_WRITER,
    systemPrompt: buildWriterSystemPrompt(Boolean(revisionHints)),
    userPrompt: buildWriterUserPrompt(writerInput, revisionHints),
    jsonMode: true,
  });

  const json = extractJsonObject(raw);
  return WriterOutputSchema.parse(JSON.parse(json));
}
