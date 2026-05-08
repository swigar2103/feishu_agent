/**
 * dotxStyleRegistry — 按报告类型定义 Word 样式色调主题
 * 每种模板对应一套 TemplatePalette，用于 wordExport 和 dotx 母版生成
 */

export type TemplatePalette = {
  /** 主强调色（heading / 表头等），6 位十六进制无 # */
  accentColor: string;
  /** 一级标题文字颜色 */
  heading1Color: string;
  /** 二级标题文字颜色 */
  heading2Color: string;
  /** 表头背景色 */
  tableHeaderBg: string;
  /** 表头文字颜色 */
  tableHeaderFg: string;
  /** Callout / 摘要块背景色 */
  calloutBg: string;
  /** Callout 左侧竖线颜色 */
  calloutBorderColor: string;
  /** 正文字体 */
  bodyFont: string;
  /** 标题字体 */
  headingFont: string;
  /** 复选框占位符字符 */
  checkboxSymbol: string;
  /** 进度颜色（甘特/时间线） */
  progressColor: string;
};

/** 飞书品牌蓝 */
const FEISHU_BLUE = "3370FF";
/** 深色中性 */
const DARK = "1F2D3D";
/** 中灰 */
const GRAY = "595959";

export const PALETTES: Record<string, TemplatePalette> = {
  weekly_report: {
    accentColor: FEISHU_BLUE,
    heading1Color: DARK,
    heading2Color: "1A3D7A",
    tableHeaderBg: "DBEAFE",
    tableHeaderFg: DARK,
    calloutBg: "EFF4FF",
    calloutBorderColor: FEISHU_BLUE,
    bodyFont: "Microsoft YaHei",
    headingFont: "Microsoft YaHei",
    checkboxSymbol: "☐",
    progressColor: FEISHU_BLUE,
  },
  daily_report: {
    accentColor: "00B96B",
    heading1Color: DARK,
    heading2Color: "006B3C",
    tableHeaderBg: "D1FAE5",
    tableHeaderFg: DARK,
    calloutBg: "ECFDF5",
    calloutBorderColor: "00B96B",
    bodyFont: "Microsoft YaHei",
    headingFont: "Microsoft YaHei",
    checkboxSymbol: "☐",
    progressColor: "00B96B",
  },
  analysis_report: {
    accentColor: "0E3F9E",
    heading1Color: "0E3F9E",
    heading2Color: "1A5276",
    tableHeaderBg: "C8D8F5",
    tableHeaderFg: "0E3F9E",
    calloutBg: "EDF2FF",
    calloutBorderColor: "0E3F9E",
    bodyFont: "Microsoft YaHei",
    headingFont: "Microsoft YaHei",
    checkboxSymbol: "→",
    progressColor: "0E3F9E",
  },
  project_plan: {
    accentColor: "6B4FBB",
    heading1Color: "4A3580",
    heading2Color: "6B4FBB",
    tableHeaderBg: "EDE9F7",
    tableHeaderFg: DARK,
    calloutBg: "F5F2FF",
    calloutBorderColor: "6B4FBB",
    bodyFont: "Microsoft YaHei",
    headingFont: "Microsoft YaHei",
    checkboxSymbol: "◎",
    progressColor: "6B4FBB",
  },
};

const FALLBACK_PALETTE = PALETTES.analysis_report as TemplatePalette;

export function getPaletteForReportType(reportType: string): TemplatePalette {
  return PALETTES[reportType] ?? FALLBACK_PALETTE;
}

/** 从 docx HeadingLevel 对应的颜色 */
export function headingColorForLevel(
  level: 1 | 2 | 3,
  palette: TemplatePalette,
): string {
  if (level === 1) return palette.heading1Color;
  if (level === 2) return palette.heading2Color;
  return GRAY;
}
