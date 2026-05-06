import { SkillSchema, type Skill } from "../../schemas/index.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { readJsonFile, writeJsonFile } from "./repo/file/fileStorage.js";
import { spawnSync } from "node:child_process";

type ExtractedTemplate = {
  id: string;
  owner: string;
  templateName: string;
  sourceDocumentRef: string;
  sourceTitle: string;
  sourceUrl?: string;
  extractedAt: string;
  sections: string[];
  templateHints: string[];
  chartRules: string[];
  layoutBlocks: Array<{ tag: string; count: number }>;
  embeddedAssets: Array<{
    kind: string;
    token?: string;
    id?: string;
  }>;
  assetDataSnapshots: Array<{
    kind: string;
    token?: string;
    id?: string;
    data: Record<string, unknown>;
  }>;
  skillDraft: Skill;
};

type TemplateStore = {
  templates: ExtractedTemplate[];
};

const STORE_FILE = "hmrs-template-skills.json";

function normalizeHeading(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[\-*]\s+/, "")
    .replace(/^\d+(\.\d+){0,2}\s+/, "")
    .replace(/^[一二三四五六七八九十]+[、.．]\s*/, "")
    .replace(/^[（(][一二三四五六七八九十\d]+[)）]\s*/, "")
    .trim();
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (/^#{1,6}\s+\S+/.test(t)) return true;
  if (/^[一二三四五六七八九十]+[、.．]\s*\S+/.test(t)) return true;
  if (/^\d+(\.\d+){0,2}\s+\S+/.test(t)) return true;
  if (/^[（(][一二三四五六七八九十\d]+[)）]\s*\S+/.test(t)) return true;
  if (/^【[^】]{2,20}】$/.test(t)) return true;
  return false;
}

function extractSections(content: string): string[] {
  const fromXml: string[] = [];
  const seenXml = new Set<string>();
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = headingRe.exec(content)) !== null) {
    const raw = headingMatch[2]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";
    const normalized = normalizeHeading(raw);
    if (normalized.length < 2 || seenXml.has(normalized)) continue;
    seenXml.add(normalized);
    fromXml.push(normalized);
    if (fromXml.length >= 12) break;
  }
  if (fromXml.length > 0) return fromXml;

  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!isHeading(line)) continue;
    const s = normalizeHeading(line);
    if (s.length < 2 || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 12) break;
  }
  if (out.length > 0) return out;
  return ["本周摘要", "完成情况", "问题与风险", "下周计划", "协作需求"];
}

function deriveTemplateHints(content: string): string[] {
  const hints: string[] = [];
  if (/表格|table/i.test(content)) hints.push("优先使用表格表达关键事项与状态。");
  if (/时间线|里程碑|timeline/i.test(content)) hints.push("包含时间线或里程碑段落。");
  if (/甘特|gantt|排期/i.test(content)) hints.push("包含任务排期/甘特图槽位。");
  if (/行动项|负责人|owner/i.test(content)) hints.push("行动项必须包含负责人和截止时间。");
  if (hints.length === 0) {
    hints.push("章节标题和顺序需严格贴合模板骨架。");
  }
  return hints;
}

function deriveChartRules(content: string): string[] {
  const rules = new Set<string>();
  if (/趋势|环比|同比/.test(content)) rules.add("趋势类指标建议折线图");
  if (/对比|TOP|排名|占比/.test(content)) rules.add("对比类指标建议柱状图或饼图");
  if (/甘特|排期/.test(content)) rules.add("项目计划建议甘特图");
  if (/时间线|里程碑/.test(content)) rules.add("关键事件建议时间线图");
  if (rules.size === 0) {
    rules.add("趋势类指标建议折线图");
    rules.add("对比类指标建议柱状图");
  }
  return [...rules];
}

function countTag(content: string, tag: string): number {
  const re = new RegExp(`<${tag}\\b`, "gi");
  return (content.match(re) ?? []).length;
}

function extractLayoutBlocks(content: string): Array<{ tag: string; count: number }> {
  const tags = [
    "h1",
    "h2",
    "h3",
    "table",
    "grid",
    "callout",
    "checkbox",
    "sheet",
    "bitable",
    "whiteboard",
    "img",
    "source",
  ];
  return tags
    .map((tag) => ({ tag, count: countTag(content, tag) }))
    .filter((item) => item.count > 0);
}

function extractEmbeddedAssets(content: string): Array<{ kind: string; token?: string; id?: string }> {
  const assets: Array<{ kind: string; token?: string; id?: string }> = [];

  const sheetRe = /<sheet\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(content)) !== null) {
    const raw = m[0];
    const token = /token="([^"]+)"/i.exec(raw)?.[1];
    const sheetId = /sheet-id="([^"]+)"/i.exec(raw)?.[1];
    assets.push({ kind: "sheet", token, id: sheetId });
  }

  const bitableRe = /<bitable\b[^>]*>/gi;
  while ((m = bitableRe.exec(content)) !== null) {
    const raw = m[0];
    const token = /token="([^"]+)"/i.exec(raw)?.[1];
    const tableId = /table-id="([^"]+)"/i.exec(raw)?.[1];
    assets.push({ kind: "bitable", token, id: tableId });
  }

  const whiteboardRe = /<whiteboard\b[^>]*>/gi;
  while ((m = whiteboardRe.exec(content)) !== null) {
    const raw = m[0];
    const token = /token="([^"]+)"/i.exec(raw)?.[1];
    assets.push({ kind: "whiteboard", token });
  }

  const imgRe = /<img\b[^>]*>/gi;
  while ((m = imgRe.exec(content)) !== null) {
    const raw = m[0];
    const token = /token="([^"]+)"/i.exec(raw)?.[1];
    assets.push({ kind: "image", token });
  }

  const fileRe = /<source\b[^>]*>/gi;
  while ((m = fileRe.exec(content)) !== null) {
    const raw = m[0];
    const token = /token="([^"]+)"/i.exec(raw)?.[1];
    assets.push({ kind: "file", token });
  }

  if (/甘特|gantt/i.test(content)) assets.push({ kind: "gantt_marker" });
  if (/时间线|timeline/i.test(content)) assets.push({ kind: "timeline_marker" });
  if (/柱状图|折线图|饼图|图表|chart/i.test(content)) assets.push({ kind: "chart_marker" });

  return assets;
}

function deriveReportType(title: string, content: string): string {
  const text = `${title}\n${content}`;
  if (/周报/.test(text)) return "weekly_report";
  if (/日报/.test(text)) return "daily_report";
  if (/复盘|回顾|总结/.test(text)) return "project_review";
  return "analysis_report";
}

function isCorruptedTemplateName(s: string | undefined): boolean {
  if (!s) return true;
  const t = s.trim();
  if (!t) return true;
  if (/\?{2,}/.test(t)) return true;
  if (/�/.test(t)) return true;
  return false;
}

function buildSkillDraft(input: {
  templateName: string;
  sections: string[];
  chartRules: string[];
}): Skill {
  return SkillSchema.parse({
    skillId: `user-template-${Date.now()}`,
    name: `用户模板-${input.templateName}`,
    industry: "通用",
    reportType: deriveReportType(input.templateName, input.sections.join("\n")),
    requiredInputs: ["时间范围", "关键事实", "行动项"],
    sections: input.sections,
    styleRules: ["沿用模板章节标题", "结论先行", "每节保留事实依据"],
    chartRules: input.chartRules,
    terminology: [],
  });
}

function loadStore(): TemplateStore {
  return readJsonFile<TemplateStore>(STORE_FILE, { templates: [] });
}

function saveStore(store: TemplateStore): void {
  writeJsonFile(STORE_FILE, store);
}

export class TemplateExtractionService {
  private runLarkCliJson(args: string[]): unknown | null {
    const proc = spawnSync("lark-cli", args, {
      encoding: "utf8",
      shell: true,
    });
    if (proc.status !== 0) return null;
    try {
      return JSON.parse(proc.stdout) as unknown;
    } catch {
      return null;
    }
  }

  private fetchViaLarkCli(documentRef: string): {
    content: string;
    title?: string;
    url?: string;
    documentId?: string;
  } | null {
    const proc = spawnSync(
      "lark-cli",
      [
        "docs",
        "+fetch",
        "--api-version",
        "v2",
        "--as",
        "user",
        "--doc",
        documentRef,
        "--detail",
        "simple",
        "--doc-format",
        "xml",
      ],
      {
        encoding: "utf8",
        shell: true,
      },
    );
    if (proc.status !== 0) return null;
    try {
      const parsed = JSON.parse(proc.stdout) as {
        ok?: boolean;
        data?: { document?: { content?: string; document_id?: string } };
      };
      const content = parsed?.data?.document?.content?.trim() ?? "";
      if (!content) return null;
      const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(content);
      return {
        content,
        title: titleMatch?.[1]?.replace(/<[^>]+>/g, "").trim() || undefined,
        url: documentRef.startsWith("http") ? documentRef : undefined,
        documentId: parsed?.data?.document?.document_id,
      };
    } catch {
      return null;
    }
  }

  private enrichSheetAsset(token: string, sheetId?: string): Record<string, unknown> {
    const info = this.runLarkCliJson([
      "sheets",
      "+info",
      "--as",
      "user",
      "--spreadsheet-token",
      token,
    ]) as
      | {
          data?: {
            sheets?: { sheets?: Array<{ sheet_id?: string; title?: string; grid_properties?: unknown }> };
          };
        }
      | null;
    const sheets = info?.data?.sheets?.sheets ?? [];
    const targetId = sheetId || sheets[0]?.sheet_id || "";
    let sampleValues: unknown[] = [];
    if (targetId) {
      const read = this.runLarkCliJson([
        "sheets",
        "+read",
        "--as",
        "user",
        "--spreadsheet-token",
        token,
        "--sheet-id",
        targetId,
        "--range",
        "A1:F20",
      ]) as
        | {
            data?: { valueRange?: { values?: unknown[] } };
          }
        | null;
      sampleValues = Array.isArray(read?.data?.valueRange?.values)
        ? (read?.data?.valueRange?.values ?? [])
        : [];
    }
    return {
      spreadsheetToken: token,
      targetSheetId: targetId || undefined,
      sheetCount: sheets.length,
      sheets: sheets.slice(0, 10).map((s) => ({
        sheetId: s.sheet_id,
        title: s.title,
      })),
      sampleValues: sampleValues.slice(0, 8),
    };
  }

  private enrichBitableAsset(token: string, tableId?: string): Record<string, unknown> {
    const tablesResp = this.runLarkCliJson([
      "base",
      "+table-list",
      "--as",
      "user",
      "--base-token",
      token,
    ]) as
      | {
          data?: { tables?: Array<{ id?: string; name?: string }> };
        }
      | null;
    const tables = tablesResp?.data?.tables ?? [];
    const targetTableId = tableId || tables[0]?.id || "";
    let fields: Array<{ id?: string; name?: string; type?: string }> = [];
    let sampleRows: unknown[] = [];
    if (targetTableId) {
      const fieldsResp = this.runLarkCliJson([
        "base",
        "+field-list",
        "--as",
        "user",
        "--base-token",
        token,
        "--table-id",
        targetTableId,
      ]) as
        | {
            data?: { fields?: Array<{ id?: string; name?: string; type?: string }> };
          }
        | null;
      fields = (fieldsResp?.data?.fields ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
      }));
      const rowsResp = this.runLarkCliJson([
        "base",
        "+record-list",
        "--as",
        "user",
        "--base-token",
        token,
        "--table-id",
        targetTableId,
        "--limit",
        "5",
        "--format",
        "json",
      ]) as
        | {
            data?: { data?: unknown[] };
          }
        | null;
      sampleRows = Array.isArray(rowsResp?.data?.data) ? (rowsResp?.data?.data ?? []) : [];
    }
    return {
      baseToken: token,
      tableCount: tables.length,
      tables: tables.slice(0, 10),
      targetTableId: targetTableId || undefined,
      fields: fields.slice(0, 50),
      sampleRows: sampleRows.slice(0, 5),
    };
  }

  private buildAssetDataSnapshots(
    assets: Array<{ kind: string; token?: string; id?: string }>,
  ): Array<{ kind: string; token?: string; id?: string; data: Record<string, unknown> }> {
    const snapshots: Array<{ kind: string; token?: string; id?: string; data: Record<string, unknown> }> = [];
    const dedup = new Set<string>();
    for (const asset of assets) {
      const key = `${asset.kind}:${asset.token ?? ""}:${asset.id ?? ""}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      if (!asset.token) continue;
      if (asset.kind === "sheet") {
        const data = this.enrichSheetAsset(asset.token, asset.id);
        snapshots.push({ kind: asset.kind, token: asset.token, id: asset.id, data });
        continue;
      }
      if (asset.kind === "bitable") {
        const data = this.enrichBitableAsset(asset.token, asset.id);
        snapshots.push({ kind: asset.kind, token: asset.token, id: asset.id, data });
      }
    }
    return snapshots;
  }

  async extractAndStore(input: {
    userId: string;
    documentRef: string;
    templateName?: string;
  }): Promise<ExtractedTemplate> {
    const viewed = await toolGateway.viewDocument(input.documentRef, {
      userId: input.userId,
      preferUserScope: true,
    });
    const cliFetched = this.fetchViaLarkCli(input.documentRef);
    const sourceTitle =
      viewed?.title?.trim() ||
      cliFetched?.title?.trim() ||
      input.templateName?.trim() ||
      input.documentRef.trim();
    const content = (viewed?.content ?? viewed?.summary ?? cliFetched?.content ?? "").trim();
    if (!content) {
      throw new Error("模板抽取失败：未读取到文档正文，请先确认该用户对文档有访问权限。");
    }
    const sections = extractSections(content);
    const templateHints = deriveTemplateHints(content);
    const chartRules = deriveChartRules(content);
    const layoutBlocks = extractLayoutBlocks(content);
    const embeddedAssets = extractEmbeddedAssets(content);
    const assetDataSnapshots = this.buildAssetDataSnapshots(embeddedAssets);
    const templateName = isCorruptedTemplateName(input.templateName)
      ? sourceTitle
      : input.templateName!.trim();
    const skillDraft = buildSkillDraft({
      templateName,
      sections,
      chartRules,
    });

    const extracted: ExtractedTemplate = {
      id: `tpl_${Date.now()}`,
      owner: input.userId,
      templateName,
      sourceDocumentRef: input.documentRef.trim(),
      sourceTitle,
      sourceUrl: viewed?.url ?? cliFetched?.url,
      extractedAt: new Date().toISOString(),
      sections,
      templateHints,
      chartRules,
      layoutBlocks,
      embeddedAssets,
      assetDataSnapshots,
      skillDraft,
    };

    const store = loadStore();
    const deduped = store.templates.filter(
      (t) => !(t.owner === input.userId && t.sourceDocumentRef === extracted.sourceDocumentRef),
    );
    deduped.unshift(extracted);
    saveStore({
      templates: deduped.slice(0, 200),
    });
    return extracted;
  }

  listByUser(userId: string): ExtractedTemplate[] {
    return loadStore().templates.filter((t) => t.owner === userId);
  }
}

