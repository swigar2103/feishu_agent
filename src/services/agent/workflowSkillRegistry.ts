import type { IntentResult } from "../../schemas/agentContracts.js";
import type { Skill } from "../../schemas/index.js";

export type WorkflowSkillEntry = {
  workflowSourceId: string;
  name: string;
  intentTags: string[];
  reportTypeKeywords: string[];
  requiredInputs: string[];
  sections: string[];
  styleRules: string[];
  toolHints: string[];
  outputTargets: Array<"feishu_doc" | "bitable" | "slides">;
  reviewRules: string[];
  priority: number;
};

export const WORKFLOW_SKILL_REGISTRY: WorkflowSkillEntry[] = [
  {
    workflowSourceId: "lark.workflow.standup-report",
    name: "standup-report",
    intentTags: ["daily_report", "weekly_report", "general_task"],
    reportTypeKeywords: ["standup", "站会", "日报", "daily"],
    // 不依赖 user prompt 英文词匹配（易误判「请补充：agenda」）；素材由检索 doc_summary + 深读补足
    requiredInputs: [],
    sections: ["今日完成", "明日计划", "阻塞项与协作", "行动项"],
    styleRules: ["结论先行", "每节最多3-5个要点", "行动项需明确 owner 与时间"],
    toolHints: ["docs +create", "docs +update", "docs +fetch"],
    outputTargets: ["feishu_doc"],
    reviewRules: [
      "是否包含 agenda",
      "是否包含 todo",
      "是否包含 summary",
    ],
    priority: 100,
  },
  {
    workflowSourceId: "lark.workflow.meeting-summary",
    name: "meeting-summary",
    intentTags: ["analysis_report", "project_review", "general_task"],
    reportTypeKeywords: ["meeting", "纪要", "会议", "summary"],
    requiredInputs: ["决策项", "行动项", "风险", "下一步"],
    sections: ["会议摘要", "关键决策", "行动项", "风险与阻塞", "下一步计划"],
    styleRules: ["先事实后判断", "行动项需包含 owner 和截止时间", "风险需包含影响范围"],
    toolHints: ["docs +create", "docs +update", "docs +fetch"],
    outputTargets: ["feishu_doc", "slides"],
    reviewRules: [
      "是否包含决策项",
      "是否包含行动项",
      "是否包含风险",
      "是否包含下一步",
    ],
    priority: 90,
  },
];

function scoreEntry(entry: WorkflowSkillEntry, intent: IntentResult): number {
  const reportType = intent.reportType.toLowerCase();
  let score = entry.intentTags.includes(intent.taskIntent) ? 0.7 : 0;
  if (entry.reportTypeKeywords.some((k) => reportType.includes(k.toLowerCase()))) {
    score += 0.3;
  }
  return Math.min(1, score);
}

export function matchWorkflowSkill(intent: IntentResult): {
  entry: WorkflowSkillEntry | null;
  confidence: number;
} {
  const ranked = WORKFLOW_SKILL_REGISTRY
    .map((entry) => ({
      entry,
      confidence: scoreEntry(entry, intent),
      priority: entry.priority,
    }))
    .filter((item) => item.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || b.priority - a.priority);
  const hit = ranked[0];
  if (!hit) {
    return { entry: null, confidence: 0 };
  }
  return { entry: hit.entry, confidence: hit.confidence };
}

export function toWorkflowSkill(
  intent: IntentResult,
  entry: WorkflowSkillEntry,
): Skill {
  return {
    skillId: `workflow-${entry.name}`,
    name: `官方工作流-${entry.name}`,
    industry: intent.industry,
    reportType: intent.reportType,
    requiredInputs: entry.requiredInputs,
    sections: entry.sections,
    styleRules: entry.styleRules,
    chartRules: ["趋势建议折线图", "对比建议柱状图"],
    terminology: [],
  };
}

