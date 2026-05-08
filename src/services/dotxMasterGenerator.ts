/**
 * dotxMasterGenerator - Generate .dotx master template files for each extracted template
 *
 * .dotx files are ZIP archives identical in structure to .docx, identified as templates
 * via word/settings.xml <w:documentType w:val="template"/>.
 * This implementation uses the docx library to produce fully styled documents saved as
 * .dotx, which Word can open directly as template files.
 *
 * Generated masters include:
 *  - Full paragraph/heading/table style definitions matching the template color theme
 *  - Template section placeholder headings
 *  - bitable/sheet headers and sample rows as real Word Tables
 *  - callout-style summary block placeholders
 *  - Gantt/timeline/chart slot text placeholder lines
 */
import fs from "node:fs";
import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
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
import {
  getPaletteForReportType,
  type TemplatePalette,
} from "./dotxStyleRegistry.js";
import { bitableToWordTable, sheetToWordTable } from "./wordTableRenderer.js";

const DOTX_DIR = path.resolve(process.cwd(), "src/data/templates/dotx");

// ??????????????????????????????????????????
// Types matching hmrs-template-skills.json
// ??????????????????????????????????????????
interface AssetField {
  id: string;
  name: string;
  type: string;
}

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

interface LayoutBlock {
  tag: string;
  count: number;
}

interface EmbeddedAsset {
  kind: string;
  token?: string;
  id?: string;
}

interface SkillDraft {
  skillId: string;
  name: string;
  reportType: string;
  sections: string[];
  styleRules: string[];
  chartRules: string[];
}

export interface StoredTemplate {
  id: string;
  templateName: string;
  sourceTitle: string;
  sections: string[];
  templateHints: string[];
  chartRules: string[];
  layoutBlocks: LayoutBlock[];
  embeddedAssets: EmbeddedAsset[];
  assetDataSnapshots: AssetDataSnapshot[];
  skillDraft: SkillDraft;
}

// ??????????????????????????????????????????
// Style builders
// ??????????????????????????????????????????

function buildDocumentStyles(palette: TemplatePalette) {
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
        paragraph: { spacing: { before: 320, after: 160 } },
      },
      heading3: {
        run: {
          bold: true,
          color: "595959",
          size: 24,
          font: palette.headingFont,
        },
        paragraph: { spacing: { before: 240, after: 120 } },
      },
      listParagraph: {
        run: { font: palette.bodyFont, size: 22 },
        paragraph: { spacing: { before: 60, after: 60 } },
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
        run: { font: palette.bodyFont, size: 20, color: palette.progressColor },
        paragraph: { spacing: { before: 60, after: 60 } },
      },
    ],
  };
}

// ??????????????????????????????????????????
// Element builders
// ??????????????????????????????????????????

function calloutP(text: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    style: "CalloutBlock",
    children: [new TextRun({ text, font: palette.bodyFont })],
  });
}

function checkboxP(text: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    style: "ChecklistItem",
    children: [
      new TextRun({
        text: `${palette.checkboxSymbol}  ${text}`,
        font: palette.bodyFont,
      }),
    ],
  });
}

function ganttP(task: string, palette: TemplatePalette): Paragraph {
  return new Paragraph({
    style: "GanttSlot",
    children: [
      new TextRun({
        text: `\u25b6 ${task}  |  \u8d1f\u8d23\u4eba\uff1a________  |  \u5f00\u59cb\uff1a____/__  |  \u622a\u6b62\uff1a____/__`,
        font: palette.bodyFont,
      }),
    ],
  });
}

function timelineP(event: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({
        text: `\u2b25 ${event}  \u2500\u2500\u2500\u2500\u2500\u2500  \u65f6\u95f4\uff1a__________`,
      }),
    ],
    spacing: { before: 60, after: 60 },
  });
}

function chartPlaceholderTable(
  chartTitle: string,
  palette: TemplatePalette,
): Table {
  const inner = new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: `\ud83d\udcca  [${chartTitle}]`,
            bold: true,
            color: palette.accentColor,
            font: palette.bodyFont,
          }),
        ],
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        children: [
          new TextRun({
            text: `\uff08\u6b64\u5904\u63d2\u5165\u56fe\u8868\uff09`,
            color: "9CA3AF",
            size: 20,
            font: palette.bodyFont,
          }),
        ],
        alignment: AlignmentType.CENTER,
      }),
    ],
    verticalAlign: VerticalAlign.CENTER,
    shading: { type: ShadingType.CLEAR, fill: "F9FAFB", color: "auto" },
    width: { size: 9000, type: WidthType.DXA },
    margins: { top: 500, bottom: 500 },
  });

  return new Table({
    rows: [new TableRow({ children: [inner] })],
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

// ??????????????????????????????????????????
// Main document builder
// ??????????????????????????????????????????

function buildMasterDocument(
  tpl: StoredTemplate,
  palette: TemplatePalette,
): Document {
  const children: (Paragraph | Table)[] = [];

  // Document title
  children.push(
    new Paragraph({
      text: tpl.templateName,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
  );

  // Template hints as a callout
  if (tpl.templateHints.length > 0) {
    children.push(calloutP(tpl.templateHints.join("  |  "), palette));
    children.push(new Paragraph({ text: "", spacing: { after: 160 } }));
  }

  const hasGantt = tpl.embeddedAssets.some((a) => a.kind === "gantt_marker");
  const hasChart = tpl.embeddedAssets.some((a) => a.kind === "chart_marker");
  const layoutTags = new Set(tpl.layoutBlocks.map((b) => b.tag));

  // Section headings with appropriate placeholders
  for (const section of tpl.sections) {
    const level =
      layoutTags.has("h2") && !layoutTags.has("h1")
        ? HeadingLevel.HEADING_2
        : HeadingLevel.HEADING_1;

    children.push(
      new Paragraph({
        text: section,
        heading: level,
        spacing: { before: 360, after: 180 },
      }),
    );

    if (layoutTags.has("checkbox")) {
      children.push(
        checkboxP("\u5f85\u586b\u5199\u4e8b\u9879\u4e00", palette),
        checkboxP("\u5f85\u586b\u5199\u4e8b\u9879\u4e8c", palette),
      );
    }

    if (layoutTags.has("grid") || layoutTags.has("callout")) {
      children.push(
        calloutP(
          "\u5173\u952e\u6458\u8981\u6216\u6307\u6807\u8bf4\u660e\uff08\u70b9\u6b64\u7f16\u8f91\uff09",
          palette,
        ),
      );
    }

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: "\u8bf7\u5728\u6b64\u5904\u586b\u5199\u5185\u5bb9\u2026\u2026",
            color: "9CA3AF",
            italics: true,
            font: palette.bodyFont,
          }),
        ],
        spacing: { after: 140 },
      }),
    );
  }

  // bitable / sheet tables
  const handledTokens = new Set<string>();
  for (const snap of tpl.assetDataSnapshots) {
    const key = `${snap.kind}:${snap.token ?? ""}:${snap.id ?? ""}`;
    if (handledTokens.has(key)) continue;
    handledTokens.add(key);

    children.push(new Paragraph({ text: "", spacing: { after: 80 } }));

    if (snap.kind === "bitable" && snap.data.fields && snap.data.sampleRows) {
      children.push(
        new Paragraph({
          style: "TableCaption",
          children: [
            new TextRun({
              text: "\u6570\u636e\u8868\uff08\u591a\u7ef4\u8868\u683c\uff09",
              font: palette.headingFont,
            }),
          ],
          spacing: { before: 200, after: 80 },
        }),
      );
      const tbl = bitableToWordTable(
        snap.data.fields as AssetField[],
        snap.data.sampleRows,
        palette,
        { maxRows: 4, totalWidthDxa: 9000 },
      );
      children.push(tbl);
    } else if (snap.kind === "sheet" && snap.data.sampleValues) {
      children.push(
        new Paragraph({
          style: "TableCaption",
          children: [
            new TextRun({
              text: "\u6570\u636e\u8868\uff08\u7535\u5b50\u8868\u683c\uff09",
              font: palette.headingFont,
            }),
          ],
          spacing: { before: 200, after: 80 },
        }),
      );
      const tbl = sheetToWordTable(
        snap.data.sampleValues as unknown[][],
        palette,
        { maxRows: 4, totalWidthDxa: 9000 },
      );
      if (tbl) children.push(tbl);
    }

    children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
  }

  // Gantt slots
  if (hasGantt) {
    children.push(
      new Paragraph({
        text: "\u4efb\u52a1\u6392\u671f / \u7518\u7279\u56fe",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    [
      "\u91cc\u7a0b\u7891\u4efb\u52a1\u4e00",
      "\u91cc\u7a0b\u7891\u4efb\u52a1\u4e8c",
      "\u91cc\u7a0b\u7891\u4efb\u52a1\u4e09",
    ].forEach((t) => {
      children.push(ganttP(t, palette));
    });
    children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
  }

  // Timeline (for project plan types)
  if (tpl.skillDraft.reportType === "project_plan" || hasGantt) {
    children.push(
      new Paragraph({
        text: "\u5173\u952e\u65f6\u95f4\u7ebf",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    ["\u542f\u52a8", "\u4e2d\u671f\u8bc4\u5ba1", "\u4ea4\u4ed8"].forEach((e) => {
      children.push(timelineP(e));
    });
    children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
  }

  // Chart placeholders
  if (hasChart) {
    children.push(
      new Paragraph({
        text: "\u6570\u636e\u56fe\u8868",
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 180 },
      }),
    );
    for (const rule of tpl.chartRules.slice(0, 2)) {
      children.push(chartPlaceholderTable(rule, palette));
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
    }
  }

  return new Document({
    styles: buildDocumentStyles(palette),
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
}

// ??????????????????????????????????????????
// Public API
// ??????????????????????????????????????????

export type DotxMasterResult = {
  templateId: string;
  templateName: string;
  dotxPath: string;
  dotxRelativePath: string;
};

/**
 * Generate .dotx master files for all templates.
 * Idempotent: skips existing files unless force=true.
 */
export async function generateDotxMasters(
  templates: StoredTemplate[],
  opts?: { force?: boolean },
): Promise<DotxMasterResult[]> {
  fs.mkdirSync(DOTX_DIR, { recursive: true });
  const results: DotxMasterResult[] = [];

  for (const tpl of templates) {
    const outPath = path.join(DOTX_DIR, `${tpl.id}.dotx`);
    const relPath = path.relative(process.cwd(), outPath).replace(/\\/g, "/");

    if (!opts?.force && fs.existsSync(outPath)) {
      results.push({
        templateId: tpl.id,
        templateName: tpl.templateName,
        dotxPath: outPath,
        dotxRelativePath: relPath,
      });
      continue;
    }

    const reportType = tpl.skillDraft?.reportType ?? "analysis_report";
    const palette = getPaletteForReportType(reportType);
    const doc = buildMasterDocument(tpl, palette);
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buffer);

    console.info(
      `[dotxMasterGenerator] \u751f\u6210\u6bcd\u7248 ${tpl.templateName} \u2192 ${relPath}`,
    );
    results.push({
      templateId: tpl.id,
      templateName: tpl.templateName,
      dotxPath: outPath,
      dotxRelativePath: relPath,
    });
  }

  return results;
}

/** Get the absolute path of a generated dotx (null if not yet generated) */
export function getDotxPath(templateId: string): string | null {
  const outPath = path.join(DOTX_DIR, `${templateId}.dotx`);
  return fs.existsSync(outPath) ? outPath : null;
}

/** Get the relative path suitable for TemplateProfile.wordExportHints.dotxRelativePath */
export function getDotxRelativePath(templateId: string): string | null {
  const abs = getDotxPath(templateId);
  if (!abs) return null;
  return path.relative(process.cwd(), abs).replace(/\\/g, "/");
}
