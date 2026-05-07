import fs from "node:fs";
import path from "node:path";
import { Packer, Paragraph, TextRun, Document, HeadingLevel } from "docx";
import type { TaskPlan, WriterOutput } from "../schemas/index.js";
import type { TemplateProfile } from "../schemas/templateProfile.js";
import type { Draft } from "../schemas/agentContracts.js";
import { sanitizeWriterOutputReport } from "./writerOutputCleanup.js";

/** 段间距（twips；约 20 twips ≈ 1 pt），减轻「整块挤在一起」观感 */
const SP = {
  titleAfter: 360,
  sectionHeadingBefore: 360,
  sectionHeadingAfter: 180,
  blockHeadingBefore: 280,
  blockHeadingAfter: 140,
  bodyAfter: 140,
  bulletAfter: 96,
} as const;

function bodyParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    spacing: { after: SP.bodyAfter },
  });
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    spacing: { after: SP.bulletAfter },
  });
}

/** B：若配置了 dotx 路径且文件存在，当前版本仍走程序化排版；预留日志提示后续接入 OOXML 合并 */
function logDotxPlaceholder(profile?: TemplateProfile | null): void {
  const rel = profile?.wordExportHints?.dotxRelativePath?.trim();
  if (!rel) return;
  const abs = path.resolve(process.cwd(), rel);
  if (fs.existsSync(abs)) {
    console.info(
      `[wordExport] 检测到 dotx 占位文件 ${rel}；当前导出仍为程序化 Document，合并逻辑待接入 docxtemplater/OpenXML。`,
    );
  }
}

function resolveSectionHeadingLevel(
  heading: string,
  profile?: TemplateProfile | null,
) {
  const rules = profile?.wordExportHints?.sectionHeadingLevels;
  if (!rules?.length) return HeadingLevel.HEADING_1;
  for (const rule of rules) {
    if (heading.includes(rule.headingIncludes)) {
      switch (rule.level) {
        case "TITLE":
          return HeadingLevel.TITLE;
        case "H1":
          return HeadingLevel.HEADING_1;
        case "H2":
          return HeadingLevel.HEADING_2;
        case "H3":
          return HeadingLevel.HEADING_3;
        default:
          return HeadingLevel.HEADING_1;
      }
    }
  }
  return HeadingLevel.HEADING_1;
}

function shouldUseNumberedList(heading: string, profile?: TemplateProfile | null): boolean {
  const hints = profile?.wordExportHints?.numberedListForSectionsIncluding ?? [];
  return hints.some((h) => heading.includes(h));
}

/** 将正文按行拆分：Markdown 标题转为 Word 标题；其余为独立段落 */
function linesToDocxParagraphs(text: string): Paragraph[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const out: Paragraph[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const marks = hm[1] ?? "#";
      const body = (hm[2] ?? "").trim();
      const depth = marks.length;
      const hl =
        depth <= 1
          ? HeadingLevel.HEADING_1
          : depth === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3;
      out.push(
        new Paragraph({
          text: body,
          heading: hl,
          spacing: {
            before: SP.blockHeadingBefore,
            after: SP.blockHeadingAfter,
          },
        }),
      );
      continue;
    }
    out.push(bodyParagraph(line));
  }
  return out;
}

/** B：按蒸馏画像对小节正文做编号列表排版（程序化模拟 Word 编号） */
function linesToNumberedOrPlainParagraphs(
  content: string,
  numbered: boolean,
): Paragraph[] {
  if (!numbered) return linesToDocxParagraphs(content);
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let i = 1;
  const out: Paragraph[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(...linesToDocxParagraphs(line));
      continue;
    }
    const cleaned = line.replace(/^-\s*/, "").replace(/^\d+\.\s*/, "").trim();
    if (!cleaned) continue;
    out.push(
      new Paragraph({
        children: [new TextRun(`${i}. ${cleaned}`)],
        spacing: { after: SP.bulletAfter },
      }),
    );
    i += 1;
  }
  return out.length > 0 ? out : linesToDocxParagraphs(content);
}

function normalizeDraftFromReport(report: WriterOutput): Draft {
  return {
    format: "doc",
    title: report.title,
    summary: report.summary,
    sections: report.sections,
    chartSuggestions: report.chartSuggestions,
    openQuestions: report.openQuestions ?? [],
    sectionBlocks: [],
    timelineSlots: [],
    ganttSlots: [],
    chartSlots: [],
  };
}

export function pickPrimaryTemplateProfile(
  profiles?: Record<string, TemplateProfile> | null,
): TemplateProfile | undefined {
  if (!profiles) return undefined;
  const vals = Object.values(profiles);
  return vals[0];
}

export async function generateReportDocxBuffer(input: {
  report: WriterOutput;
  draft?: Draft;
  taskPlan?: TaskPlan;
  debugTrace?: string[];
  templateProfile?: TemplateProfile | null;
}): Promise<Buffer> {
  logDotxPlaceholder(input.templateProfile ?? undefined);

  const profile = input.templateProfile ?? undefined;
  const report = sanitizeWriterOutputReport(input.report);
  const draft = input.draft ?? normalizeDraftFromReport(report);

  const sectionParagraphs: Paragraph[] = [
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: SP.titleAfter },
    }),
    new Paragraph({
      children: [new TextRun({ text: "摘要", bold: true })],
      heading: HeadingLevel.HEADING_1,
      spacing: {
        before: SP.blockHeadingBefore,
        after: SP.blockHeadingAfter,
      },
    }),
    ...linesToDocxParagraphs(report.summary),
  ];

  for (const section of report.sections) {
    const hl = resolveSectionHeadingLevel(section.heading, profile);
    sectionParagraphs.push(
      new Paragraph({
        text: section.heading,
        heading: hl,
        spacing: {
          before: SP.sectionHeadingBefore,
          after: SP.sectionHeadingAfter,
        },
      }),
    );
    const numbered = shouldUseNumberedList(section.heading, profile);
    sectionParagraphs.push(
      ...linesToNumberedOrPlainParagraphs(section.content, numbered),
    );
  }

  if (report.chartSuggestions.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "图表建议",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const chart of report.chartSuggestions) {
      sectionParagraphs.push(
        bulletParagraph(
          `- ${chart.title}（${chart.type}）：${chart.purpose}；数据建议：${chart.dataHint}`,
        ),
      );
    }
  }

  if (draft.timelineSlots.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "时间线",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const slot of draft.timelineSlots) {
      sectionParagraphs.push(
        bulletParagraph(
          `- ${slot.title}｜周期：${slot.periodHint}${slot.notes ? `｜说明：${slot.notes}` : ""}`,
        ),
      );
    }
  }

  if (draft.ganttSlots.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "甘特任务",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const slot of draft.ganttSlots) {
      sectionParagraphs.push(
        bulletParagraph(
          `- ${slot.task}｜负责人：${slot.ownerHint ?? "待定"}｜开始：${slot.startHint ?? "待定"}｜结束：${slot.endHint ?? "待定"}`,
        ),
      );
    }
  }

  if (draft.chartSlots.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "图表槽位",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const slot of draft.chartSlots) {
      sectionParagraphs.push(
        bulletParagraph(
          `- ${slot.title}（${slot.chartType}）｜指标建议：${slot.metricHint}`,
        ),
      );
    }
  }

  if (draft.sectionBlocks.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "模板版式块",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const block of draft.sectionBlocks) {
      sectionParagraphs.push(
        bulletParagraph(
          `- [${block.blockType}] ${block.sectionHeading}：${block.content.slice(0, 180)}`,
        ),
      );
    }
  }

  if (report.openQuestions.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "待补充问题",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const q of report.openQuestions) {
      sectionParagraphs.push(bulletParagraph(`- ${q}`));
    }
  }

  if (input.taskPlan) {
    sectionParagraphs.push(
      new Paragraph({
        text: "执行计划摘要",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    sectionParagraphs.push(
      bodyParagraph(
        `报告类型：${input.taskPlan.reportType}；技能：${input.taskPlan.selectedSkillId}；语气：${input.taskPlan.targetTone}`,
      ),
    );
  }

  if (input.debugTrace && input.debugTrace.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "流程追踪",
        heading: HeadingLevel.HEADING_1,
        spacing: {
          before: SP.blockHeadingBefore,
          after: SP.blockHeadingAfter,
        },
      }),
    );
    for (const trace of input.debugTrace) {
      sectionParagraphs.push(bulletParagraph(`- ${trace}`));
    }
  }

  const doc = new Document({
    sections: [
      {
        children: sectionParagraphs,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
