/**
 * wordTableRenderer - Convert bitable/sheet snapshots into docx Table objects
 * Used in Word export to generate actual data tables (not plain-text placeholders)
 */
import {
  Table,
  TableRow,
  TableCell,
  Paragraph,
  TextRun,
  WidthType,
  AlignmentType,
  ShadingType,
  BorderStyle,
  VerticalAlign,
} from "docx";
import type { TemplatePalette } from "./dotxStyleRegistry.js";

export type AssetField = { id: string; name: string; type: string };

const MAX_CELL_TEXT = 60;

function cellValue(raw: unknown): string {
  if (raw == null) return "";
  if (Array.isArray(raw)) {
    return raw
      .map((v) =>
        typeof v === "object" && v !== null && "name" in v
          ? String((v as { name: unknown }).name ?? "")
          : String(v),
      )
      .filter(Boolean)
      .join(", ")
      .slice(0, MAX_CELL_TEXT);
  }
  return String(raw).slice(0, MAX_CELL_TEXT);
}

function styledCell(
  text: string,
  opts: {
    bold?: boolean;
    color?: string;
    bg?: string;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    colWidth?: number;
    font?: string;
  },
): TableCell {
  const {
    bold = false,
    color,
    bg,
    align = AlignmentType.LEFT,
    colWidth,
    font = "Microsoft YaHei",
  } = opts;
  return new TableCell({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold,
            color: color ?? "1F2D3D",
            font,
            size: 20,
          }),
        ],
        alignment: align,
        spacing: { before: 80, after: 80 },
      }),
    ],
    verticalAlign: VerticalAlign.CENTER,
    width: colWidth != null ? { size: colWidth, type: WidthType.DXA } : undefined,
    shading: bg
      ? { type: ShadingType.CLEAR, fill: bg, color: "auto" }
      : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}

/** Render bitable fields + sample rows as a Word Table */
export function bitableToWordTable(
  fields: AssetField[],
  sampleRows: unknown[][],
  palette: TemplatePalette,
  opts?: { maxRows?: number; totalWidthDxa?: number },
): Table {
  const totalWidth = opts?.totalWidthDxa ?? 9000;
  const maxRows = opts?.maxRows ?? 5;
  const colWidth = Math.floor(totalWidth / Math.max(fields.length, 1));

  const headerRow = new TableRow({
    tableHeader: true,
    children: fields.map((f) =>
      styledCell(f.name, {
        bold: true,
        color: palette.tableHeaderFg,
        bg: palette.tableHeaderBg,
        align: AlignmentType.CENTER,
        colWidth,
        font: palette.bodyFont,
      }),
    ),
  });

  const dataRows = sampleRows.slice(0, maxRows).map(
    (row) =>
      new TableRow({
        children: fields.map((_, idx) =>
          styledCell(cellValue(row[idx]), {
            colWidth,
            font: palette.bodyFont,
          }),
        ),
      }),
  );

  if (dataRows.length === 0) {
    dataRows.push(
      new TableRow({
        children: fields.map(() =>
          styledCell("", { colWidth, font: palette.bodyFont }),
        ),
      }),
    );
  }

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: totalWidth, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB" },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB" },
    },
  });
}

/** Render sheet sample values as a Word Table (first row = header) */
export function sheetToWordTable(
  sampleValues: unknown[][],
  palette: TemplatePalette,
  opts?: { maxRows?: number; totalWidthDxa?: number },
): Table | null {
  if (!sampleValues.length) return null;

  const headerRaw = sampleValues[0] ?? [];
  const headers = headerRaw.map((v) =>
    v == null ? "" : String(v).slice(0, MAX_CELL_TEXT),
  );
  if (headers.filter(Boolean).length === 0) return null;

  const totalWidth = opts?.totalWidthDxa ?? 9000;
  const maxRows = opts?.maxRows ?? 5;
  const colWidth = Math.floor(totalWidth / Math.max(headers.length, 1));

  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map((h) =>
      styledCell(h, {
        bold: true,
        color: palette.tableHeaderFg,
        bg: palette.tableHeaderBg,
        align: AlignmentType.CENTER,
        colWidth,
        font: palette.bodyFont,
      }),
    ),
  });

  const dataRows = sampleValues.slice(1, maxRows + 1).map(
    (row) =>
      new TableRow({
        children: headers.map((_, idx) =>
          styledCell(cellValue(row[idx]), {
            colWidth,
            font: palette.bodyFont,
          }),
        ),
      }),
  );

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: totalWidth, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "D1D5DB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB" },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "E5E7EB" },
    },
  });
}
