import { SkillSchema, type Skill } from "../../schemas/index.js";
import type { IntentResult } from "../../schemas/agentContracts.js";
import { readJsonFile } from "../hmrs/repo/file/fileStorage.js";
import { getDotxRelativePath } from "../wordExport.js";

export type AssetField = { id: string; name: string; type: string };

export type AssetDataSnapshot = {
  kind: string;
  token?: string;
  id?: string;
  data: {
    fields?: AssetField[];
    sampleRows?: unknown[][];
    sampleValues?: unknown[][];
    [key: string]: unknown;
  };
};

type StoredTemplate = {
  id: string;
  owner: string;
  templateName: string;
  sourceTitle?: string;
  sections?: string[];
  templateHints?: string[];
  chartRules?: string[];
  layoutBlocks?: Array<{ tag: string; count: number }>;
  embeddedAssets?: Array<{ kind: string; token?: string; id?: string }>;
  assetDataSnapshots?: AssetDataSnapshot[];
  skillDraft?: Skill;
};

type TemplateStore = {
  templates: StoredTemplate[];
};

type CatalogSnapshot = {
  items?: Array<Record<string, unknown>>;
};

type IndexSnapshot = {
  items?: Array<Record<string, unknown>>;
};

function toLower(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

function includesAny(text: string, candidates: string[]): boolean {
  return candidates.some((x) => text.includes(x));
}

function taskIntentKeywords(intent: IntentResult): string[] {
  if (intent.taskIntent === "daily_report") return ["日报", "每日", "daily"];
  if (intent.taskIntent === "weekly_report") return ["周报", "weekly"];
  if (intent.taskIntent === "project_review") return ["项目", "复盘", "里程碑", "计划"];
  if (intent.taskIntent === "analysis_report") return ["分析", "经营", "业务", "报告"];
  return ["报告", "总结"];
}

function loadTemplates(): StoredTemplate[] {
  const store = readJsonFile<TemplateStore>("hmrs-template-skills.json", { templates: [] });
  const catalog = readJsonFile<CatalogSnapshot>("hmrs-catalog.json", { items: [] });
  const index = readJsonFile<IndexSnapshot>("hmrs-index.json", { items: [] });
  const indexById = new Map<string, Record<string, unknown>>();
  for (const item of index.items ?? []) {
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;
    indexById.set(id, item);
  }
  const fromHmrs = (catalog.items ?? [])
    .filter((item) => item.wingId === "templates_wing")
    .map((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const owner = typeof item.owner === "string" ? item.owner : "global";
      const title = typeof item.title === "string" ? item.title : id;
      const sourceTitle = typeof item.summary === "string" ? item.summary : title;
      const idx = id ? indexById.get(id) : undefined;
      const structure = typeof idx?.structureSummary === "string" ? idx.structureSummary : "";
      const guessedSections = structure
        .split(/[、,，;；\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 30)
        .slice(0, 8);
      const skillDraft: Skill = SkillSchema.parse({
        skillId: `hmrs_${id || title}`,
        name: title,
        industry: "通用",
        reportType: guessedSections.some((s) => /周报|weekly/i.test(s))
          ? "weekly_report"
          : guessedSections.some((s) => /会议|summary/i.test(s))
            ? "meeting_summary"
            : "analysis_report",
        requiredInputs: [],
        sections: guessedSections.length > 0 ? guessedSections : ["执行摘要", "关键进展", "下一步计划"],
        styleRules: ["优先贴合用户历史模板结构"],
        chartRules: [],
        terminology: [],
      });
      return {
        id: `hmrs_tpl_${id || title}`,
        owner,
        templateName: title,
        sourceTitle,
        sections: skillDraft.sections,
        skillDraft,
      } satisfies StoredTemplate;
    });
  return [...(store.templates ?? []), ...fromHmrs];
}

export function matchTemplateSkill(input: {
  intent: IntentResult;
  prompt?: string;
  userId?: string;
}): {
  template: StoredTemplate;
  selectedSkill: Skill;
  confidence: number;
  /** dotx 母版相对路径（已生成时存在） */
  dotxRelativePath?: string;
  /** bitable/sheet 数据快照，用于生成真实 Word 表格 */
  assetDataSnapshots?: AssetDataSnapshot[];
} | null {
  const templates = loadTemplates();
  if (templates.length === 0) return null;

  const reportType = toLower(input.intent.reportType);
  const prompt = toLower(input.prompt);
  const intentKeys = taskIntentKeywords(input.intent).map((x) => x.toLowerCase());

  const ranked = templates
    .map((tpl) => {
      const draft = tpl.skillDraft
        ? SkillSchema.safeParse(tpl.skillDraft).success
          ? SkillSchema.parse(tpl.skillDraft)
          : null
        : null;
      if (!draft) return null;
      let score = 0;
      if (input.userId && tpl.owner === input.userId) score += 0.2;
      const tplReportType = toLower(draft.reportType);
      if (tplReportType === input.intent.taskIntent || tplReportType === reportType) score += 0.35;
      const nameText = `${toLower(tpl.templateName)} ${toLower(tpl.sourceTitle)}`;
      if (prompt && (prompt.includes(toLower(tpl.templateName)) || prompt.includes(toLower(tpl.sourceTitle)))) {
        score += 0.35;
      }
      if (includesAny(nameText, intentKeys)) score += 0.2;
      if (includesAny(reportType, intentKeys)) score += 0.05;
      return {
        template: tpl,
        selectedSkill: draft,
        confidence: Math.min(1, score),
      };
    })
    .filter((x): x is { template: StoredTemplate; selectedSkill: Skill; confidence: number } => Boolean(x))
    .sort((a, b) => b.confidence - a.confidence);

  const hit = ranked[0];
  if (!hit || hit.confidence < 0.45) return null;

  return {
    ...hit,
    dotxRelativePath: getDotxRelativePath(hit.template.id) ?? undefined,
    assetDataSnapshots: hit.template.assetDataSnapshots ?? [],
  };
}

