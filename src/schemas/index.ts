import { z } from "zod";

export const TaskIntentSchema = z.enum([
  "weekly_report",
  "daily_report",
  "review_report",
  "analysis_report",
  "general_report",
]);

export type TaskIntent = z.infer<typeof TaskIntentSchema>;

export const UserRequestSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  industry: z.string().optional(),
  reportType: z.string().optional(),
  extraContext: z.array(z.string()).optional().default([]),
  personalKnowledge: z.array(z.string()).optional().default([]),
  historyDocs: z.array(z.string()).optional().default([]),
  imContacts: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        role: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
  outputFormat: z.enum(["structured", "word"]).optional().default("structured"),
  outputTargets: z
    .array(z.enum(["feishu_doc", "bitable", "slides"]))
    .optional()
    .default(["feishu_doc"]),
});

export type UserRequest = z.infer<typeof UserRequestSchema>;

export const SkillSchema = z.object({
  skillId: z.string().min(1),
  name: z.string().min(1),
  industry: z.string().min(1),
  reportType: z.string().min(1),
  requiredInputs: z.array(z.string()).default([]),
  sections: z.array(z.string()).min(1),
  styleRules: z.array(z.string()).default([]),
  chartRules: z.array(z.string()).default([]),
  terminology: z.array(z.string()).default([]),
});

export type Skill = z.infer<typeof SkillSchema>;

/**
 * 注入到 retrievalContext 的 userMemory 视图（Writer 直接消费的字段）。
 * 与持久化的 UserMemorySchema 相比不含 usageCount/recentTones 等元数据。
 */
export const UserMemoryViewSchema = z.object({
  preferredTone: z.string().optional(),
  preferredStructure: z.array(z.string()).optional().default([]),
  commonTerms: z.array(z.string()).optional().default([]),
  styleNotes: z.array(z.string()).optional().default([]),
});

export type UserMemoryView = z.infer<typeof UserMemoryViewSchema>;

/**
 * 持久化到 data/memory/<userId>.json 的完整用户记忆。
 * Phase 3 引入元数据以支持 "越用越聪明"：
 *   - usageCount: 该用户累计生成次数
 *   - lastUsedAt: 最近一次生成时间（ISO）
 *   - recentTones: 最近 N 次 taskPlan.targetTone，用多数投票/最近优先得到 preferredTone
 *   - recentSkillIds: 最近使用过的 skillId
 *   - schemaVersion: 便于未来迁移
 */
export const UserMemorySchema = UserMemoryViewSchema.extend({
  userId: z.string().min(1),
  usageCount: z.number().int().nonnegative().default(0),
  lastUsedAt: z.string().optional(),
  recentTones: z.array(z.string()).default([]),
  recentSkillIds: z.array(z.string()).default([]),
  schemaVersion: z.number().int().positive().default(1),
});

export type UserMemory = z.infer<typeof UserMemorySchema>;

export const RetrievalContextSchema = z.object({
  matchedSkill: SkillSchema,
  userMemory: UserMemoryViewSchema,
  projectContext: z.array(
    z.object({
      sourceId: z.string(),
      sourceType: z.enum(["message", "doc", "table", "history", "calendar", "external", "im"]),
      content: z.string(),
    })
  ).default([]),
  glossary: z.array(z.string()).default([]),
  styleHints: z.array(z.string()).default([]),
});

export type RetrievalContext = z.infer<typeof RetrievalContextSchema>;

export const TaskPlanSchema = z.object({
  reportType: z.string().min(1),
  selectedSkillId: z.string().min(1),
  missingFields: z.array(z.string()).default([]),
  targetSections: z.array(z.string()).min(1),
  targetTone: z.string().min(1),
  useSources: z.array(z.string()).default([]),
});

export type TaskPlan = z.infer<typeof TaskPlanSchema>;

export const KpiTrendSchema = z.enum(["up", "down", "flat", "unknown"]);

export const KpiEntrySchema = z.object({
  name: z.string().min(1),
  value: z.string().optional(),
  unit: z.string().optional(),
  trend: KpiTrendSchema.default("unknown"),
  delta: z.string().optional(),
  sourceId: z.string().optional(),
  note: z.string().optional(),
});

export type KpiEntry = z.infer<typeof KpiEntrySchema>;

export const ChartCandidateSchema = z.object({
  type: z.enum(["line", "bar", "pie", "area", "scatter", "table"]),
  title: z.string().min(1),
  purpose: z.string().min(1),
  dataHint: z.string().min(1),
  priority: z.number().min(0).max(1).default(0.5),
});

export type ChartCandidate = z.infer<typeof ChartCandidateSchema>;

export const AnalystOutputSchema = z.object({
  kpis: z.array(KpiEntrySchema).default([]),
  chartCandidates: z.array(ChartCandidateSchema).default([]),
  dataQualityNotes: z.array(z.string()).default([]),
  highlights: z.array(z.string()).default([]),
});

export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

export const WriterInputSchema = z.object({
  userRequest: UserRequestSchema,
  taskPlan: TaskPlanSchema,
  retrievalContext: RetrievalContextSchema,
  analystOutput: AnalystOutputSchema.optional(),
});

export type WriterInput = z.infer<typeof WriterInputSchema>;

export const ReviewIssueSchema = z.object({
  type: z.enum([
    "coverage",       // 章节覆盖不全
    "style",          // 语气/行文风格与 styleRules 不符
    "data_quality",   // 数据口径 / KPI 使用不当
    "terminology",    // 术语未统一
    "structure",      // 结构/顺序不合理
    "completeness",   // 结论/行动项不完整
    "other",
  ]),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1),
  suggestion: z.string().optional(),
  targetSection: z.string().optional(),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const ReviewReportSchema = z.object({
  pass: z.boolean(),
  overallScore: z.number().min(0).max(1).default(0.6),
  issues: z.array(ReviewIssueSchema).default([]),
  summary: z.string().default(""),
});

export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export const WriterOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  sections: z.array(
    z.object({
      heading: z.string().min(1),
      content: z.string().min(1),
    })
  ),
  chartSuggestions: z.array(
    z.object({
      type: z.string().min(1),
      title: z.string().min(1),
      purpose: z.string().min(1),
      dataHint: z.string().min(1),
    })
  ).default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type WriterOutput = z.infer<typeof WriterOutputSchema>;