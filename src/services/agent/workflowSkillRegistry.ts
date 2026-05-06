import fs from "node:fs";
import path from "node:path";
import type { IntentResult } from "../../schemas/agentContracts.js";
import type { Skill } from "../../schemas/index.js";

export type WorkflowSkillEntry = {
  workflowSourceId: string;
  name: string;
  description?: string;
  intentTags: string[];
  reportTypeKeywords: string[];
  requiredInputs: string[];
  sections: string[];
  styleRules: string[];
  toolHints: string[];
  outputTargets: Array<"feishu_doc" | "bitable" | "slides">;
  reviewRules: string[];
  templateHints: string[];
  qualityChecks: string[];
  priority: number;
};

const FALLBACK_WORKFLOW_SKILL_REGISTRY: WorkflowSkillEntry[] = [
  {
    workflowSourceId: "lark.workflow.standup-report",
    name: "standup-report",
    description: "日程待办摘要",
    intentTags: ["daily_report", "weekly_report", "general_task"],
    reportTypeKeywords: ["standup", "站会", "日报", "daily"],
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
    templateHints: ["优先输出“日程安排 + 待办事项 + 小结”结构，可使用表格表达日程。"],
    qualityChecks: ["需要体现时间排序、冲突检测、RSVP 状态映射。"],
    priority: 100,
  },
  {
    workflowSourceId: "lark.workflow.meeting-summary",
    name: "meeting-summary",
    description: "会议纪要汇总",
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
    templateHints: ["优先输出“会议概览统计 + 逐会议详情 + 后续行动”。"],
    qualityChecks: ["会议详情需包含时间、主题、纪要链接或无纪要说明。"],
    priority: 90,
  },
];

type WorkflowFileMeta = {
  name: string;
  description: string;
};

function readFileSafe(absPath: string): string {
  if (!fs.existsSync(absPath)) return "";
  try {
    return fs.readFileSync(absPath, "utf-8");
  } catch {
    return "";
  }
}

function parseFrontMatterMeta(md: string): WorkflowFileMeta | null {
  const block = /^---\n([\s\S]*?)\n---/m.exec(md)?.[1];
  if (!block) return null;
  const name = /name:\s*([^\n]+)/.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = /description:\s*([^\n]+)/.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!name || !description) return null;
  return { name, description };
}

function parseTemplateSections(md: string): string[] {
  const section = /### Step 3: AI 汇总[\s\S]*?```([\s\S]*?)```/m.exec(md)?.[1] ?? "";
  const headers = [...section.matchAll(/^###\s+(.+)$/gm)]
    .map((m) => m[1]?.trim())
    .filter((x): x is string => Boolean(x));
  if (headers.length > 0) return headers;
  const generic = [...md.matchAll(/^###\s+(.+)$/gm)]
    .map((m) => m[1]?.trim())
    .filter((x): x is string => Boolean(x))
    .slice(0, 6);
  return generic;
}

function parseTools(md: string): string[] {
  const cmds = new Set<string>();
  for (const m of md.matchAll(/lark-cli\s+([a-z-]+)\s+\+([a-z-]+)/gi)) {
    if (m[1] && m[2]) cmds.add(`${m[1]} +${m[2]}`);
  }
  return [...cmds];
}

function deriveEntryFromCliSkill(absPath: string): WorkflowSkillEntry | null {
  const md = readFileSafe(absPath);
  if (!md) return null;
  const meta = parseFrontMatterMeta(md);
  if (!meta) return null;
  const isStandup = meta.name.includes("standup");
  const isMeeting = meta.name.includes("meeting");
  if (!isStandup && !isMeeting) return null;

  const sections = parseTemplateSections(md);
  const toolHints = parseTools(md);
  const reviewRules = [...md.matchAll(/^\d+\.\s+\*\*(.+?)\*\*[:：]?/gm)]
    .map((m) => m[1]?.trim())
    .filter((x): x is string => Boolean(x));

  return {
    workflowSourceId: `lark.workflow.${isStandup ? "standup-report" : "meeting-summary"}`,
    name: isStandup ? "standup-report" : "meeting-summary",
    description: meta.description,
    intentTags: isStandup
      ? ["daily_report", "weekly_report", "general_task"]
      : ["analysis_report", "project_review", "general_task"],
    reportTypeKeywords: isStandup
      ? ["standup", "站会", "日报", "daily", "周报"]
      : ["meeting", "纪要", "会议", "summary", "周报"],
    requiredInputs: isStandup ? ["日期范围"] : ["时间范围", "会议列表", "纪要链接"],
    sections: sections.length > 0
      ? sections
      : isStandup
        ? ["日程安排", "待办事项", "小结"]
        : ["会议概览", "逐会议详情", "行动项"],
    styleRules: isStandup
      ? ["按时间排序", "优先列表和表格", "输出冲突提醒与空闲时段"]
      : ["先统计后展开", "会议详情需有时间和链接", "行动项带 owner 与截止时间"],
    toolHints,
    outputTargets: isMeeting ? ["feishu_doc", "slides"] : ["feishu_doc"],
    reviewRules: reviewRules.length > 0 ? reviewRules : ["结构完整", "关键字段完整"],
    templateHints: isStandup
      ? ["鼓励使用“时间|事件|组织者|状态”表格。"]
      : ["按单日/多日场景切换“今日会议概览”或“会议纪要周报”标题结构。"],
    qualityChecks: isStandup
      ? ["校验时间转换与冲突检测规则。"]
      : ["校验 meeting-id 翻页完整、纪要缺失说明完整。"],
    priority: isStandup ? 100 : 90,
  };
}

function loadCliWorkflowEntries(): WorkflowSkillEntry[] {
  const root = path.resolve(process.cwd(), "cli-main", "skills");
  const files = [
    path.join(root, "lark-workflow-standup-report", "SKILL.md"),
    path.join(root, "lark-workflow-meeting-summary", "SKILL.md"),
  ];
  const loaded = files
    .map((file) => deriveEntryFromCliSkill(file))
    .filter((x): x is WorkflowSkillEntry => Boolean(x));
  return loaded.length > 0 ? loaded : FALLBACK_WORKFLOW_SKILL_REGISTRY;
}

export const WORKFLOW_SKILL_REGISTRY: WorkflowSkillEntry[] = loadCliWorkflowEntries();

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

