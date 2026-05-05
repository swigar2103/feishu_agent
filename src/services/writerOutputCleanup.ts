import type { WriterOutput } from "../schemas/index.js";

/** 检测 `WriterOutputSchema` 中空小节占位（全文见 schemas/index.ts） */
const EMPTY_SECTION_MARKER = "本节暂无内容";

function stripHeadingDecor(s: string): string {
  return s.replace(/【|】/g, "").trim() || "本小节";
}

/**
 * 将模型/schema 兜底产生的「技术向」占位改写为可读说明，并剔除明显系统口吻的 openQuestions。
 */
export function sanitizeWriterOutputReport(input: WriterOutput): WriterOutput {
  const sections = input.sections.map((sec) => {
    if (!sec.content.includes(EMPTY_SECTION_MARKER)) return sec;
    const title = stripHeadingDecor(sec.heading);
    return {
      ...sec,
      content: `围绕「${title}」暂无单独展开的增量说明；要点已体现在上文摘要及「工作内容」「已完成」等相关小节中，此处不再重复罗列。`,
    };
  });

  const openQuestions = input.openQuestions.filter((q) => {
    const t = q.trim();
    if (!t) return false;
    if (/请补充字段|可通过\s*IM\s*联系人收集|IM\s*联系人/i.test(t)) return false;
    return true;
  });

  return { ...input, sections, openQuestions };
}
