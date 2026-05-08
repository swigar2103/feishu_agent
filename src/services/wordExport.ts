import fs from "node:fs";
import path from "node:path";
import {
  Packer,
  Paragraph,
  TextRun,
  Document,
  HeadingLevel,
  AlignmentType,
  ShadingType,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  VerticalAlign,
} from "docx";
import type { TaskPlan, WriterOutput } from "../schemas/index.js";
import type { TemplateProfile } from "../schemas/templateProfile.js";
import type { Draft } from "../schemas/agentContracts.js";
import { sanitizeWriterOutputReport } from "./writerOutputCleanup.js";
import {
  getPaletteForReportType,
  type TemplatePalette,
} from "./dotxStyleRegistry.js";
import {
  bitableToWordTable,
  sheetToWordTable,
  type AssetField,
} from "./wordTableRenderer.js";
import { getDotxRelativePath } from "./dotxMasterGenerator.js";

// ????????????????????????????????????????????????
// Style definitions (injected per-document)
// ????????????????????????????????????????????????

function buildStyles(palette: TemplatePalette) {
  return {
    default: {
      document: {
        run: { font: palette.bodyFont, size: 22, color: "1F2D3D" },
        paragraph: { spacing: { line: 360, after: 140 } },
      },
      heading1: {
        run: {
          bold: true,
          color: palette.heading1Color,
          size: 34,
          font: palette.headingFont,
        },
        paragraph: {
          spacing: { before: 400, after: 200 },
          border: {
            bottom: {
              color: palette.accentColor,
              style: BorderStyle.SINGLE,
              size: 6,
              space: 4,
            },
          },
        },
      },
      heading2: {
        run: {
          bold: true,
          color: palette.heading2Color,
          size: 28,
          font: palette.headingFont,
        },
        paragraph: { spacing: { before: 300, after: 140 } },
      },
      heading3: {
        run: {
          bold: true,
          color: "595959",
          size: 24,
          font: palette.headingFont,
        },
        paragraph: { spacing: { before: 220, after: 100 } },
      },
    },
    paragraphStyles: [
      {
        id: "CalloutBlock",
        name: "Callout Block",
        basedOn: "Normal",
        run: {
          font: palette.bodyFont,
          size: 22,
          color: palette.heading2Color,
          italics: true,
        },
        paragraph: {
          shading: {
            type: ShadingType.CLEAR,
            fill: palette.calloutBg,
            color: "auto",
          },
          border: {
            left: {
              color: palette.calloutBorderColor,
              style: BorderStyle.SINGLE,
              size: 18,
              space: 8,
            },
          },
          spacing: { before: 120, after: 120 },
          indent: { left: 360 },
        },
      },
      {
        id: "ChecklistItem",
        name: "Checklist Item",
        basedOn: "Normal",
        run: { font: palette.bodyFont, size: 22 },
        paragraph: { spacing: { before: 80, after: 80 } },
      },
      {
        id: "TableCaption",
        name: "Table Caption",
        basedOn: "Normal",
        run: {
          bold: true,
          font: palette.headingFont,
          size: 20,
          color: palette.heading2Color,
        },
        paragraph: { spacing: { before: 200, after: 80 } },
      },
      {
        id: "GanttSlot",
        name: "Gantt Slot",
        basedOn: "Normal",
        run: {
          font: palette.bodyFont,
          size: 20,
          color: palette.progressColor,
        },
        paragraph: { spacing: { before: 60, after: 60 } },
      },
    ],
  };
}

// ????????????????????????????????????????????????
// Element helpers
// ????????????????????????????????????????????????

function bodyParagraph(text: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: palette.bodyFont })],
    spacing: { after: 140 },
  });
}

function bulletParagraph(text: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: palette.bodyFont })],
    spacing: { after: 96 },
    indent: { left: 360 },
  });
}

function calloutParagraph(text: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    style: "CalloutBlock",
    children: [new TextRun({ text, font: palette.bodyFont })],
  });
}

function ganttRow(task: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    style: "GanttSlot",
    children: [
      new TextRun({
        text: `\u25b6 ${task}`,
        font: palette.bodyFont,
      }),
    ],
  });
}

function chartPlaceholderTable(title: string, palette: TemplatePalette): Table {
  return new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: `\ud83d\udcca  [${title}]\uff08\u6b64\u5904\u63d2\u5165\u56fe\u8868\uff09`,
                    bold: true,
                    color: palette.accentColor,
                    font: palette.bodyFont,
                  }),
                ],
                alignment: AlignmentType.CENTER,
                spacing: { before: 400, after: 400 },
              }),
            ],
            verticalAlign: VerticalAlign.CENTER,
            shading: {
              type: ShadingType.CLEAR,
              fill: "F9FAFB",
              color: "auto",
            },
            width: { size: 9000, type: WidthType.DXA },
          }),
        ],
      }),
    ],
    width: { size: 9000, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.DASHED, size: 6, color: palette.accentColor },
      bottom: {
        style: BorderStyle.DASHED,
        size: 6,
        color: palette.accentColor,
      },
      left: { style: BorderStyle.DASHED, size: 6, color: palette.accentColor },
      right: {
        style: BorderStyle.DASHED,
        size: 6,
        color: palette.accentColor,
      },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
    },
  });
}

// ????????????????????????????????????????????????
// Heading level resolvers
// ????????????????????????????????????????????????

function resolveSectionHeadingLevel(
  heading: string,
  profile?: TemplateProfile | null,
): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
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

function shouldUseNumberedList(
  heading: string,
  profile?: TemplateProfile | null,
): boolean {
  const hints =
    profile?.wordExportHints?.numberedListForSectionsIncluding ?? [];
  return hints.some((h) => heading.includes(h));
}

// ????????????????????????????????????????????????
// Body text -> paragraphs
// ????????????????????????????????????????????????

function linesToDocxParagraphs(
  text: string,
  palette: TemplatePalette,
): Paragraph[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const out: Paragraph[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      const depth = (hm[1] ?? "#").length;
      const body = (hm[2] ?? "").trim();
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
          spacing: { before: 280, after: 140 },
        }),
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      out.push(bulletParagraph(line.replace(/^[-*]\s+/, "\u2022 "), palette));
      continue;
    }
    out.push(bodyParagraph(line, palette));
  }
  return out;
}

function linesToNumberedOrPlain(
  content: string,
  numbered: boolean,
  palette: TemplatePalette,
): Paragraph[] {
  if (!numbered) return linesToDocxParagraphs(content, palette);
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let i = 1;
  const out: Paragraph[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      out.push(...linesToDocxParagraphs(line, palette));
      continue;
    }
    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .trim();
    if (!cleaned) continue;
    out.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${i}. ${cleaned}`, font: palette.bodyFont }),
        ],
        spacing: { after: 96 },
      }),
    );
    i += 1;
  }
  return out.length > 0 ? out : linesToDocxParagraphs(content, palette);
}

// ????????????????????????????????????????????????
// Asset snapshot types
// ????????????????????????????????????????????????

interface AssetDataSnapshot {
  kind: string;
  token?: string;
  id?: string;
  data: {
    fields?: AssetField[];
    sampleRows?: unknown[][];
    sampleValues?: unknown[][];
    [key: string]: unknown;
  };
}

// ????????????????????????????????????????????????
// Helpers
// ????????????????????????????????????????????????

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

function resolveDotxPath(profile?: TemplateProfile | null): string | null {
  const rel = profile?.wordExportHints?.dotxRelativePath?.trim();
  if (!rel) return null;
  const abs = path.resolve(process.cwd(), rel);
  return fs.existsSync(abs) ? abs : null;
}

// ????????????????????????????????????????????????
// Main export function
// ????????????????????????????????????????????????

export async function generateReportDocxBuffer(input: {
  report: WriterOutput;
  draft?: Draft;
  taskPlan?: TaskPlan;
  debugTrace?: string[];
  templateProfile?: TemplateProfile | null;
  templateId?: string;
  reportType?: string;
  assetDataSnapshots?: AssetDataSnapshot[];
}): Promise<Buffer> {
  const profile = input.templateProfile ?? undefined;
  const report = sanitizeWriterOutputReport(input.report);
  const draft = input.draft ?? normalizeDraftFromReport(report);

  const reportType =
    input.reportType ?? input.taskPlan?.reportType ?? "analysis_report";
  const palette = getPaletteForReportType(reportType);

  const dotxPath = resolveDotxPath(profile);
  if (dotxPath) {
    console.info(
      `[wordExport] \u68c0\u6d4b\u5230 dotx \u6bcd\u7248 ${path.basename(dotxPath)}\uff0c\u8f93\u51fa\u6837\u5f0f\u4e0e\u6bcd\u7248\u4fdd\u6301\u4e00\u81f4\u3002`,
    );
  }

  const children: (Paragraph | Table)[] = [];

  // Title
  children.push(
    new Paragraph({
      text: report.title,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
  );

  // Summary (callout style)
  children.push(
    new Paragraph({
      text: "\u6458\u8981",
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 360, after: 160 },
    }),
  );
  if (report.summary.trim()) {
    children.push(calloutParagraph(report.summary.trim(), palette));
  }

  // Sections
  for (const section of report.sections) {
    const hl = resolveSectionHeadingLevel(section.heading, profile);
    children.push(
      new Paragraph({
        text: section.heading,
        heading: hl,
        spacing: { before: 360, after: 180 },
      }),
    );
    const numbered = shouldUseNumberedList(section.heading, profile);
    children.push(
      ...linesToNumberedOrPlain(section.content, numbered, palette),
    );
  }

  // bitable / sheet tables from template snapshots
  if (input.assetDataSnapshots && input.assetDataSnapshots.length > 0) {
    const rendered = new Set<string>();
    for (const snap of input.assetDataSnapshots) {
      const key = `${snap.kind}:${snap.token ?? ""}:${snap.id ?? ""}`;
      if (rendered.has(key)) continue;
      rendered.add(key);

      children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
      const captionText =
        snap.kind === "bitable"
          ? "\u6570\u636e\u8868\uff08\u591a\u7ef4\u8868\u683c\uff09"
          : snap.kind === "sheet"
            ? "\u6570\u636e\u8868\uff08\u7535\u5b50\u8868\u683c\uff09"
            : "\u6570\u636e\u8868";
      children.push(
        new Paragraph({
          style: "TableCaption",
          children: [
            new TextRun({ text: captionText, font: palette.headingFont }),
          ],
          spacing: { before: 200, after: 80 },
        }),
      );

      if (
        snap.kind === "bitable" &&
        snap.data.fields &&
        snap.data.sampleRows
      ) {
        const tbl = bitableToWordTable(
          snap.data.fields as AssetField[],
          snap.data.sampleRows,
          palette,
          { totalWidthDxa: 9000 },
        );
        children.push(tbl);
      } else if (snap.kind === "sheet" && snap.data.sampleValues) {
        const tbl = sheetToWordTable(
          snap.data.sampleValues as unknown[][],
          palette,
          { totalWidthDxa: 9000 },
        );
        if (tbl) children.push(tbl);
      }
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
    }
  }

  // Chart suggestions
  if (report.chartSuggestions.length > 0) {
    children.push(
      new Paragraph({
        text: "\u56fe\u8868\u5efa\u8bae",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const chart of report.chartSuggestions) {
      children.push(
        bulletParagraph(
          `\u2022 ${chart.title}\uff08${chart.type}\uff09\uff1a${chart.purpose}\uff1b\u6570\u636e\u5efa\u8bae\uff1a${chart.dataHint}`,
          palette,
        ),
      );
    }
  }

  // Timeline slots
  if (draft.timelineSlots.length > 0) {
    children.push(
      new Paragraph({
        text: "\u65f6\u95f4\u7ebf",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const slot of draft.timelineSlots) {
      children.push(
        bulletParagraph(
          `\u2b25 ${slot.title}\uff5c\u5468\u671f\uff1a${slot.periodHint}${slot.notes ? `\uff5c\u8bf4\u660e\uff1a${slot.notes}` : ""}`,
          palette,
        ),
      );
    }
  }

  // Gantt slots
  if (draft.ganttSlots.length > 0) {
    children.push(
      new Paragraph({
        text: "\u4efb\u52a1\u6392\u671f / \u7518\u7279\u56fe",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const slot of draft.ganttSlots) {
      children.push(
        ganttRow(
          `${slot.task}\uff5c\u8d1f\u8d23\u4eba\uff1a${slot.ownerHint ?? "\u5f85\u5b9a"}\uff5c\u5f00\u59cb\uff1a${slot.startHint ?? "\u5f85\u5b9a"}\uff5c\u622a\u6b62\uff1a${slot.endHint ?? "\u5f85\u5b9a"}`,
          palette,
        ),
      );
    }
    children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
  }

  // Chart slots (dashed placeholder boxes)
  if (draft.chartSlots.length > 0) {
    children.push(
      new Paragraph({
        text: "\u6570\u636e\u56fe\u8868",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const slot of draft.chartSlots) {
      children.push(
        chartPlaceholderTable(
          `${slot.title}\uff08${slot.chartType}\uff09`,
          palette,
        ),
      );
      children.push(new Paragraph({ text: "", spacing: { after: 80 } }));
    }
  }

  // Section blocks (callout / checkbox / other)
  if (draft.sectionBlocks.length > 0) {
    children.push(
      new Paragraph({
        text: "\u9644\u52a0\u7248\u5f0f\u5757",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const block of draft.sectionBlocks) {
      const btype = block.blockType as string;
      if (btype === "callout") {
        children.push(calloutParagraph(block.content.slice(0, 300), palette));
      } else if (btype === "checkbox") {
        children.push(
          new Paragraph({
            style: "ChecklistItem",
            children: [
              new TextRun({
                text: `${palette.checkboxSymbol}  ${block.sectionHeading}\uff1a${block.content.slice(0, 200)}`,
                font: palette.bodyFont,
              }),
            ],
          }),
        );
      } else {
        children.push(
          bulletParagraph(
            `[${block.blockType}] ${block.sectionHeading}\uff1a${block.content.slice(0, 200)}`,
            palette,
          ),
        );
      }
    }
  }

  // Open questions
  if (report.openQuestions.length > 0) {
    children.push(
      new Paragraph({
        text: "\u5f85\u8865\u5145\u95ee\u9898",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const q of report.openQuestions) {
      children.push(bulletParagraph(`\u2022 ${q}`, palette));
    }
  }

  // Task plan summary
  if (input.taskPlan) {
    children.push(
      new Paragraph({
        text: "\u6267\u884c\u8ba1\u5212\u6458\u8981",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    children.push(
      bodyParagraph(
        `\u62a5\u544a\u7c7b\u578b\uff1a${input.taskPlan.reportType}\uff1b\u6280\u80fd\uff1a${input.taskPlan.selectedSkillId}\uff1b\u8bed\u6c14\uff1a${input.taskPlan.targetTone}`,
        palette,
      ),
    );
  }

  // Debug trace
  if (input.debugTrace && input.debugTrace.length > 0) {
    children.push(
      new Paragraph({
        text: "\u6d41\u7a0b\u8ffd\u8e2a",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const trace of input.debugTrace) {
      children.push(bulletParagraph(`\u2022 ${trace}`, palette));
    }
  }

  const doc = new Document({
    styles: buildStyles(palette),
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1440, right: 1134, bottom: 1440, left: 1134 },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// ????????????????????????????????????????????????
// Lazy dotx master generation
// ????????????????????????????????????????????????

let _dotxGenerated = false;

export async function ensureDotxMasters(
  templates: Array<{ id: string; [key: string]: unknown }>,
): Promise<void> {
  if (_dotxGenerated) return;
  _dotxGenerated = true;
  try {
    const { generateDotxMasters } = await import("./dotxMasterGenerator.js");
    await generateDotxMasters(
      templates as unknown as Parameters<typeof generateDotxMasters>[0],
    );
  } catch (e) {
    console.warn(
      "[wordExport] dotx \u6bcd\u7248\u751f\u6210\u5931\u8d25\uff08\u975e\u81f4\u547d\uff09\uff1a",
      e,
    );
  }
}

export { getDotxRelativePath };
