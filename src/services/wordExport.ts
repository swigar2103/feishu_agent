import fs from "node:fs";
import path from "node:path";
import { Packer, Paragraph, TextRun, Document, HeadingLevel } from "docx";
import type { TaskPlan, WriterOutput } from "../schemas/index.js";
import type { TemplateProfile } from "../schemas/templateProfile.js";

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
      out.push(new Paragraph({ text: body, heading: hl }));
      continue;
    }
    out.push(new Paragraph(line));
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
    out.push(new Paragraph(`${i}. ${cleaned}`));
    i += 1;
  }
  return out.length > 0 ? out : linesToDocxParagraphs(content);
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
  taskPlan?: TaskPlan;
  debugTrace?: string[];
  templateProfile?: TemplateProfile | null;
}): Promise<Buffer> {
  logDotxPlaceholder(input.templateProfile ?? undefined);

  const profile = input.templateProfile ?? undefined;

  const sectionParagraphs: Paragraph[] = [
    new Paragraph({
      text: input.report.title,
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [new TextRun({ text: "摘要", bold: true })],
      heading: HeadingLevel.HEADING_1,
    }),
    ...linesToDocxParagraphs(input.report.summary),
  ];

  for (const section of input.report.sections) {
    const hl = resolveSectionHeadingLevel(section.heading, profile);
    sectionParagraphs.push(
      new Paragraph({
        text: section.heading,
        heading: hl,
      }),
    );
    const numbered = shouldUseNumberedList(section.heading, profile);
    sectionParagraphs.push(
      ...linesToNumberedOrPlainParagraphs(section.content, numbered),
    );
  }

  if (input.report.chartSuggestions.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "图表建议",
        heading: HeadingLevel.HEADING_1,
      }),
    );
    for (const chart of input.report.chartSuggestions) {
      sectionParagraphs.push(
        new Paragraph(
          `- ${chart.title}（${chart.type}）：${chart.purpose}；数据建议：${chart.dataHint}`,
        ),
      );
    }
  }

  if (input.report.openQuestions.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "待补充问题",
        heading: HeadingLevel.HEADING_1,
      }),
    );
    for (const q of input.report.openQuestions) {
      sectionParagraphs.push(new Paragraph(`- ${q}`));
    }
  }

  if (input.taskPlan) {
    sectionParagraphs.push(
      new Paragraph({
        text: "执行计划摘要",
        heading: HeadingLevel.HEADING_1,
      }),
    );
    sectionParagraphs.push(
      new Paragraph(
        `报告类型：${input.taskPlan.reportType}；技能：${input.taskPlan.selectedSkillId}；语气：${input.taskPlan.targetTone}`,
      ),
    );
  }

  if (input.debugTrace && input.debugTrace.length > 0) {
    sectionParagraphs.push(
      new Paragraph({
        text: "流程追踪",
        heading: HeadingLevel.HEADING_1,
      }),
    );
    for (const trace of input.debugTrace) {
      sectionParagraphs.push(new Paragraph(`- ${trace}`));
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
