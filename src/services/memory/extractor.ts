import type {
  AnalystOutput,
  RetrievalContext,
  TaskPlan,
  UserMemory,
  UserRequest,
  WriterOutput,
} from "../../schemas/index.js";
import { UserMemorySchema } from "../../schemas/index.js";

/**
 * 偏好抽取 & 融合（Phase 3）。
 *
 * 设计思路：
 *   - 从一次运行中抽取"可信信号"：taskPlan.targetTone、matchedSkillId、writerOutput 章节标题、
 *     用到的术语（Analyst KPI 名称 + skill.terminology 与报告正文交集）
 *   - 与旧 memory 做融合：不是覆盖，而是"加权计数 + 最近性偏置"
 *     - preferredTone：最近 N 次 tone 做多数投票，平票取最近
 *     - preferredStructure / commonTerms：累加，按最近出现 + 频次排序，截断
 *     - recentSkillIds：最近 N 条 skillId
 *
 * Phase 3 先实现最小闭环：recent 窗口 + 多数投票，频次计数放到 Phase 3.x 迭代。
 */

const MAX_RECENT_TONES = 5;
const MAX_RECENT_SKILLS = 10;
const MAX_STRUCTURE = 10;
const MAX_TERMS = 20;

type ExtractSignals = {
  tone?: string;
  skillId?: string;
  sectionsUsed: string[];
  termsUsed: string[];
};

/** 统计一个字符串在 haystack 里出现的子串（简单包含，不考虑词边界）。*/
function stringAppears(needle: string, haystack: string): boolean {
  if (!needle || needle.length < 2) return false;
  return haystack.includes(needle);
}

/**
 * 从本次运行中抽取偏好信号。
 *
 * 注意：只抽取"Writer 实际用了"的东西，不做纯假设。
 *   - tone 来自 taskPlan.targetTone（Planner 最终决定值，Writer 已消费）
 *   - sectionsUsed 取 writerOutput.sections[].heading（实际落到输出的章节）
 *   - termsUsed 从 skill.terminology 与 KPI 名称里取"真的出现在正文中的"那些
 */
function extractSignals(state: {
  taskPlan: TaskPlan;
  retrievalContext: RetrievalContext;
  writerOutput: WriterOutput;
  analystOutput: AnalystOutput | null;
}): ExtractSignals {
  const { taskPlan, retrievalContext, writerOutput, analystOutput } = state;

  const bodyText = [
    writerOutput.title,
    writerOutput.summary,
    ...writerOutput.sections.map((s) => `${s.heading}\n${s.content}`),
  ].join("\n");

  const skillTerms = retrievalContext.matchedSkill.terminology ?? [];
  const kpiNames = (analystOutput?.kpis ?? []).map((k) => k.name).filter(Boolean);
  const termCandidates = Array.from(new Set([...skillTerms, ...kpiNames]));
  const termsUsed = termCandidates.filter((t) => stringAppears(t, bodyText));

  return {
    tone: taskPlan.targetTone,
    skillId: taskPlan.selectedSkillId,
    sectionsUsed: writerOutput.sections.map((s) => s.heading.trim()).filter(Boolean),
    termsUsed,
  };
}

/** 把新值推到窗口头部（最新优先），保留前 N 条，保证唯一 */
function pushRecent(list: string[], value: string | undefined, maxLen: number): string[] {
  if (!value) return list.slice(0, maxLen);
  const next = [value, ...list.filter((v) => v !== value)];
  return next.slice(0, maxLen);
}

/** 多数投票 + 平票取最近（recent 窗口头为最新） */
function majorityTone(recentTones: string[]): string | undefined {
  if (recentTones.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const t of recentTones) counts.set(t, (counts.get(t) ?? 0) + 1);

  let bestTone: string | undefined;
  let bestCount = -1;
  let bestIdx = Number.POSITIVE_INFINITY;
  for (let idx = 0; idx < recentTones.length; idx++) {
    const t = recentTones[idx]!;
    const c = counts.get(t) ?? 0;
    if (c > bestCount || (c === bestCount && idx < bestIdx)) {
      bestTone = t;
      bestCount = c;
      bestIdx = idx;
    }
  }
  return bestTone;
}

/**
 * 把新条目合并到现有列表：
 *   - 新条目放前面（最近优先）
 *   - 保留原列表中未被替代的条目
 *   - 截断到 maxLen
 */
function mergeStringList(existing: string[], incoming: string[], maxLen: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...incoming, ...existing]) {
    const v = item.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    result.push(v);
    if (result.length >= maxLen) break;
  }
  return result;
}

/**
 * 把一次运行抽到的信号融合进旧 memory，返回新的 UserMemory（待持久化）。
 */
export function mergeMemoryWithRun(
  old: UserMemory,
  signals: ExtractSignals,
  now: Date = new Date(),
): UserMemory {
  const recentTones = pushRecent(old.recentTones, signals.tone, MAX_RECENT_TONES);
  const recentSkillIds = pushRecent(old.recentSkillIds, signals.skillId, MAX_RECENT_SKILLS);
  const preferredTone = majorityTone(recentTones) ?? old.preferredTone;
  const preferredStructure = mergeStringList(
    old.preferredStructure ?? [],
    signals.sectionsUsed,
    MAX_STRUCTURE,
  );
  const commonTerms = mergeStringList(old.commonTerms ?? [], signals.termsUsed, MAX_TERMS);

  return UserMemorySchema.parse({
    userId: old.userId,
    preferredTone,
    preferredStructure,
    commonTerms,
    styleNotes: old.styleNotes ?? [],
    usageCount: (old.usageCount ?? 0) + 1,
    lastUsedAt: now.toISOString(),
    recentTones,
    recentSkillIds,
    schemaVersion: old.schemaVersion ?? 1,
  });
}

/**
 * 一次性 API：从 pipeline 末态 + 旧 memory → 新 memory。
 * memoryWriterNode 会直接调用这个。
 */
export function buildUpdatedMemory(params: {
  old: UserMemory;
  userRequest: UserRequest;
  taskPlan: TaskPlan;
  retrievalContext: RetrievalContext;
  writerOutput: WriterOutput;
  analystOutput: AnalystOutput | null;
}): UserMemory {
  const signals = extractSignals({
    taskPlan: params.taskPlan,
    retrievalContext: params.retrievalContext,
    writerOutput: params.writerOutput,
    analystOutput: params.analystOutput,
  });
  return mergeMemoryWithRun({ ...params.old, userId: params.userRequest.userId }, signals);
}
