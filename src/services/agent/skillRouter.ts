import fs from "node:fs";
import path from "node:path";
import { SkillSchema, type Skill } from "../../schemas/index.js";
import { SkillMatchSchema, type IntentResult, type SkillMatch } from "../../schemas/agentContracts.js";
import { parseSkillDocFromMd, type SkillDoc } from "../retrieval/mdParser.js";
import { loadLarkCliGuidance } from "./larkCliGuidance.js";
import { matchWorkflowSkill, toWorkflowSkill } from "./workflowSkillRegistry.js";

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
    styleRules: Array.from(new Set([...skill.styleRules, ...guidance.templateHints])),
  });
}

export function routeSkill(intent: IntentResult): SkillMatch {
  const referenceDocs = loadSkillDocs(path.resolve(process.cwd(), "src", "skills"));
  const anchorDocs = loadSkillDocs(path.resolve(process.cwd(), "SKILLS"));
  const larkCliGuidance = loadLarkCliGuidance();
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
