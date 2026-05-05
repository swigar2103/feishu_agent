import { WriterOutputSchema } from "../../schemas/index.js";
import { sanitizeWriterOutputReport } from "../../services/writerOutputCleanup.js";
import type { ReportGraphStateType } from "../state.js";

export async function formatOutput(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.writerOutput) {
    throw new Error("format_output 缺少 writerOutput");
  }

  const writerOutput = sanitizeWriterOutputReport(
    WriterOutputSchema.parse({
      ...state.writerOutput,
      openQuestions: Array.from(
        new Set([...(state.writerOutput.openQuestions ?? []), ...state.followUpQuestions]),
      ),
    }),
  );
  return {
    writerOutput,
    debugTrace: [
      `[format_output] output validated sections=${writerOutput.sections.length}`,
      `[format_output] openQuestions=${writerOutput.openQuestions.length}`,
    ],
  };
}
