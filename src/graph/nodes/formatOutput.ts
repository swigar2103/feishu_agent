import { WriterOutputSchema } from "../../schemas/index.js";
import type { ReportGraphStateType } from "../state.js";

// 归一化用于去重比较：去空白、去常见标点、转小写
function normalizeForDedup(q: string): string {
  return q
    .toLowerCase()
    .replace(/[\s，,。.；;:：、！!？?（）()「」《》""''"'\-]+/gu, "")
    .trim();
}

// 以语义归一化后的字符串为 key 做去重，保留首次出现的原始写法
function dedupeQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of questions) {
    const q = raw.trim();
    if (!q) continue;
    const key = normalizeForDedup(q);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(q);
  }
  return result;
}

export async function formatOutput(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.writerOutput) {
    throw new Error("format_output 缺少 writerOutput");
  }

  const merged = [
    ...(state.writerOutput.openQuestions ?? []),
    ...state.followUpQuestions,
  ];
  const openQuestions = dedupeQuestions(merged);

  const writerOutput = WriterOutputSchema.parse({
    ...state.writerOutput,
    openQuestions,
  });

  return {
    writerOutput,
    debugTrace: [
      `[format_output] output validated sections=${writerOutput.sections.length}`,
      `[format_output] openQuestions=${writerOutput.openQuestions.length} (deduped from ${merged.length})`,
    ],
  };
}
