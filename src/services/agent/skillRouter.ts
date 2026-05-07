import fs from "node:fs";
import path from "node:path";
import { env } from "../../config/env.js";
import { SkillSchema, type Skill } from "../../schemas/index.js";
import { SkillMatchSchema, type IntentResult, type SkillMatch } from "../../schemas/agentContracts.js";
import { parseSkillDocFromMd, type SkillDoc } from "../retrieval/mdParser.js";
import { loadLarkCliGuidance } from "./larkCliGuidance.js";
import { matchWorkflowSkill, toWorkflowSkill } from "./workflowSkillRegistry.js";
import { matchTemplateSkill } from "./templateSkillStore.js";

function collectMdFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectMdFiles(abs));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(path.relative(process.cwd(), abs));
    }
  }
  return files;
}

function inferSkillWithMeta(doc: SkillDoc): Skill {
  const explicitIndustry = doc.meta.metadata.industry?.trim();
  const explicitReportType = doc.meta.metadata.reportType?.trim();
  return SkillSchema.parse({
    ...doc.skill,
    industry: explicitIndustry || doc.skill.industry,
    reportType: explicitReportType || doc.skill.reportType,
  });
}

function pickBestSkill(docs: SkillDoc[], intent: IntentResult): SkillDoc | null {
  if (docs.length === 0) return null;
  const industry = intent.industry.toLowerCase();
  const reportType = intent.reportType.toLowerCase();

  const exact = docs.find((doc) => {
    const skill = inferSkillWithMeta(doc);
    return (
      skill.industry.toLowerCase() === industry &&
      skill.reportType.toLowerCase() === reportType
    );
  });
  if (exact) return exact;

  const reportMatched = docs.find(
    (doc) => inferSkillWithMeta(doc).reportType.toLowerCase() === reportType,
  );
  if (reportMatched) return reportMatched;

  const industryMatched = docs.find(
    (doc) => inferSkillWithMeta(doc).industry.toLowerCase() === industry,
  );
  if (industryMatched) return industryMatched;

  return docs[0] ?? null;
}

function loadSkillDocs(rootAbs: string): SkillDoc[] {
  const files = collectMdFiles(rootAbs);
  const docs: SkillDoc[] = [];
  for (const file of files) {
    try {
      docs.push(parseSkillDocFromMd(file));
    } catch {
      // skip invalid skill docs
    }
  }
  return docs;
}

function fallbackSkill(intent: IntentResult): Skill {
  return SkillSchema.parse({
    skillId: "skill-fallback-generic",
    name: "通用任务技能",
    industry: intent.industry,
    reportType: intent.reportType,
    requiredInputs: ["任务目标", "时间范围", "关键事实"],
    sections: ["执行摘要", "分析结论", "行动建议"],
    styleRules: ["结论先行", "语言简洁"],
    chartRules: ["趋势用折线图", "对比用柱状图"],
    terminology: [],
  });
}

function enrichSkillWithGuidance(skill: Skill): Skill {
  const guidance = loadLarkCliGuidance();
  if (!guidance.enabled) return skill;
  return SkillSchema.parse({
    ...skill,
    styleRules: Array.from(
      new Set([
        ...skill.styleRules,
        ...guidance.styleHints,
        ...guidance.templateHints,
        ...guidance.hardRules.map((rule) => `【硬约束】${rule}`),
      ]),
    ),
  });
}

export function routeSkill(
  intent: IntentResult,
  input?: { prompt?: string; userId?: string },
): SkillMatch {
  const referenceDocs = loadSkillDocs(path.resolve(process.cwd(), "src", "skills"));
  const anchorDocs = loadSkillDocs(path.resolve(process.cwd(), "SKILLS"));
  const larkCliGuidance = loadLarkCliGuidance();
  if (env.LARK_CLI_GUIDANCE_REQUIRED && !larkCliGuidance.enabled) {
    throw new Error(
      "模板层要求 lark-cli guidance，但当前未加载到 cli-main/docs 规范，请检查 cli-main 测试样例与配置。",
    );
  }
  const templateMatched = matchTemplateSkill({
    intent,
    prompt: input?.prompt,
    userId: input?.userId,
  });
  if (templateMatched) {
    const templateSkill = enrichSkillWithGuidance(templateMatched.selectedSkill);
    return SkillMatchSchema.parse({
      selectedSkill: templateSkill,
      matchReason: `命中用户模板：${templateMatched.template.templateName}`,
      source: "user_template",
      larkCliGuidance: larkCliGuidance.enabled ? larkCliGuidance : undefined,
      workflowMeta: {
        workflowSourceId: `hmrs.template.${templateMatched.template.id}`,
        workflowTemplateId: templateMatched.template.templateName,
        confidence: templateMatched.confidence,
        recommendedTools: ["docs +fetch", "docs +update"],
        outputTargets: ["feishu_doc"],
        reviewRules: [
          "章节顺序与模板保持一致",
          "保留模板中关键版式块与填空位",
        ],
        templateHints: templateMatched.template.templateHints ?? [],
        qualityChecks: (templateMatched.template.layoutBlocks ?? []).map(
          (b) => `layout:${b.tag}>=${b.count}`,
        ),
      },
    });
  }
  const workflowMatched = matchWorkflowSkill(intent);
  if (workflowMatched.entry) {
    const workflowSkill = enrichSkillWithGuidance(
      SkillSchema.parse(toWorkflowSkill(intent, workflowMatched.entry)),
    );
    return SkillMatchSchema.parse({
      selectedSkill: workflowSkill,
      matchReason: `命中官方 workflow: ${workflowMatched.entry.name}`,
      source: "lark_cli_workflow",
      larkCliGuidance: larkCliGuidance.enabled ? larkCliGuidance : undefined,
      workflowMeta: {
        workflowSourceId: workflowMatched.entry.workflowSourceId,
        workflowTemplateId: workflowMatched.entry.name,
        confidence: workflowMatched.confidence,
        recommendedTools: workflowMatched.entry.toolHints,
        outputTargets: workflowMatched.entry.outputTargets,
        reviewRules: workflowMatched.entry.reviewRules,
        templateHints: workflowMatched.entry.templateHints,
        qualityChecks: workflowMatched.entry.qualityChecks,
      },
    });
  }

  const reference = pickBestSkill(referenceDocs, intent);
  if (reference) {
    const skill = enrichSkillWithGuidance(inferSkillWithMeta(reference));
    return SkillMatchSchema.parse({
      selectedSkill: skill,
      matchReason: "命中 src/skills 主技能库",
      source: "reference",
      larkCliGuidance: larkCliGuidance.enabled ? larkCliGuidance : undefined,
    });
  }

  const anchor = pickBestSkill(anchorDocs, intent);
  if (anchor) {
    const skill = enrichSkillWithGuidance(inferSkillWithMeta(anchor));
    return SkillMatchSchema.parse({
      selectedSkill: skill,
      matchReason: "主技能库未命中，回退锚点技能库",
      source: "anchor",
      larkCliGuidance: larkCliGuidance.enabled ? larkCliGuidance : undefined,
    });
  }

  return SkillMatchSchema.parse({
    selectedSkill: enrichSkillWithGuidance(fallbackSkill(intent)),
    matchReason: "未命中任何技能，使用内置 fallback",
    source: "fallback",
    larkCliGuidance: larkCliGuidance.enabled ? larkCliGuidance : undefined,
  });
}
