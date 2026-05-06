import { z } from "zod";
import { SkillSchema, UserRequestSchema, WriterOutputSchema } from "./index.js";

export const TaskRequestSchema = z.object({
  requestId: z.string().min(1),
  receivedAt: z.string().min(1),
  userRequest: UserRequestSchema,
  normalizedPrompt: z.string().min(1),
  isValid: z.boolean(),
  validityLevel: z.enum(["accepted", "needs_clarification", "rejected"]).default("accepted"),
  guardHints: z.array(z.string()).default([]),
  invalidReason: z.string().optional(),
});

export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export const ResourceTypeSchema = z.enum([
  "doc_summary",
  "table_summary",
  "message_thread_summary",
  "contact_summary",
  "user_profile",
  "project_memory",
]);

export type ResourceType = z.infer<typeof ResourceTypeSchema>;

export const ResourceSummarySchema = z.object({
  resourceId: z.string().min(1),
  resourceType: ResourceTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  project: z.string().optional(),
  tags: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
  link: z.string().optional(),
  score: z.number().min(0).max(1).optional(),
});

export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;

export const CandidateResourceListSchema = z.object({
  candidates: z.array(ResourceSummarySchema).default([]),
  usedLlmFallback: z.boolean().default(false),
  screeningReason: z.array(z.string()).default([]),
});

export type CandidateResourceList = z.infer<typeof CandidateResourceListSchema>;

export const TaskIntentSchema = z.enum([
  "weekly_report",
  "daily_report",
  "analysis_report",
  "project_review",
  "general_task",
]);

export const OutputKindSchema = z.enum(["doc", "ppt", "canvas", "table"]);

export const IntentResultSchema = z.object({
  taskIntent: TaskIntentSchema,
  outputKind: OutputKindSchema,
  industry: z.string().min(1),
  reportType: z.string().min(1),
  initialGaps: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
});

export type IntentResult = z.infer<typeof IntentResultSchema>;

export const LarkCliGuidanceSchema = z.object({
  enabled: z.boolean().default(false),
  sourceRoot: z.string().default(""),
  supportedDocsCommands: z.array(z.string()).default([]),
  commandPatterns: z.array(z.string()).default([]),
  hardRules: z.array(z.string()).default([]),
  styleHints: z.array(z.string()).default([]),
  templateHints: z.array(z.string()).default([]),
  qualityChecks: z.array(z.string()).default([]),
  workflowTemplates: z
    .array(
      z.object({
        workflowTemplateId: z.string().min(1),
        workflowSourceId: z.string().min(1),
        sections: z.array(z.string()).default([]),
        reviewRules: z.array(z.string()).default([]),
        recommendedTools: z.array(z.string()).default([]),
        outputTargets: z
          .array(z.enum(["feishu_doc", "bitable", "slides"]))
          .default(["feishu_doc"]),
        templateHints: z.array(z.string()).default([]),
        qualityChecks: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export const WorkflowMetaSchema = z.object({
  workflowSourceId: z.string().min(1),
  workflowTemplateId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  recommendedTools: z.array(z.string()).default([]),
  outputTargets: z
    .array(z.enum(["feishu_doc", "bitable", "slides"]))
    .default([]),
  reviewRules: z.array(z.string()).default([]),
  templateHints: z.array(z.string()).default([]),
  qualityChecks: z.array(z.string()).default([]),
});

export const SkillMatchSchema = z.object({
  selectedSkill: SkillSchema,
  matchReason: z.string().min(1),
  source: z
    .enum(["reference", "anchor", "fallback", "lark_cli_workflow"])
    .default("fallback"),
  larkCliGuidance: LarkCliGuidanceSchema.optional(),
  workflowMeta: WorkflowMetaSchema.optional(),
});

export type SkillMatch = z.infer<typeof SkillMatchSchema>;

export const ExecutionPlanSchema = z.object({
  reportType: z.string().min(1),
  selectedSkillId: z.string().min(1),
  targetSections: z.array(z.string()).min(1),
  targetTone: z.string().min(1),
  prioritizedResourceIds: z.array(z.string()).default([]),
  missingFields: z.array(z.string()).default([]),
  followUpQuestions: z.array(z.string()).default([]),
  retrievalStrategy: z.string().min(1),
});

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export const DetailedContextSchema = z.object({
  facts: z.array(
    z.object({
      sourceId: z.string().min(1),
      fact: z.string().min(1),
      evidence: z.string().optional(),
    }),
  ).default([]),
  sourceDetails: z.array(
    z.object({
      resourceId: z.string().min(1),
      detail: z.string().min(1),
    }),
  ).default([]),
});

export type DetailedContext = z.infer<typeof DetailedContextSchema>;

export const AnalysisResultSchema = z.object({
  normalizedFacts: z.array(z.string()).default([]),
  metricDefinitions: z.array(z.string()).default([]),
  keyInsights: z.array(z.string()).default([]),
  chartSuggestions: WriterOutputSchema.shape.chartSuggestions.default([]),
});

export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const DraftSchema = WriterOutputSchema.extend({
  format: OutputKindSchema.default("doc"),
  /**
   * Draft v2：供「在线编辑工作台」和发布层做结构化处理。
   * 所有新增字段均为可选，确保兼容旧 Writer 输出。
   */
  sectionBlocks: z
    .array(
      z.object({
        blockId: z.string().min(1),
        sectionHeading: z.string().min(1),
        blockType: z.enum(["paragraph", "bullet_list", "table", "timeline", "gantt", "chart_slot"]),
        content: z.string().min(1),
      }),
    )
    .default([]),
  timelineSlots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        title: z.string().min(1),
        periodHint: z.string().min(1),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  ganttSlots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        task: z.string().min(1),
        ownerHint: z.string().optional(),
        startHint: z.string().optional(),
        endHint: z.string().optional(),
      }),
    )
    .default([]),
  chartSlots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        chartType: z.string().min(1),
        title: z.string().min(1),
        metricHint: z.string().min(1),
      }),
    )
    .default([]),
});

export type Draft = z.infer<typeof DraftSchema>;

export const StyleReviewResultSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
});

export type StyleReviewResult = z.infer<typeof StyleReviewResultSchema>;

export const ComplianceIssueTypeSchema = z.enum([
  "planner_gap",
  "data_quality",
  "ok",
]);

export const ComplianceReviewResultSchema = z.object({
  pass: z.boolean(),
  issueType: ComplianceIssueTypeSchema,
  issues: z.array(z.string()).default([]),
});

export type ComplianceReviewResult = z.infer<typeof ComplianceReviewResultSchema>;

export const FinalDeliverableSchema = z.object({
  outputKind: OutputKindSchema,
  title: z.string().min(1),
  content: DraftSchema,
  outputTargets: z.array(z.enum(["feishu_doc", "bitable", "slides"])).default(["feishu_doc"]),
  publishedArtifacts: z
    .array(
      z.object({
        type: z.enum(["feishu_doc", "bitable", "slides"]),
        id: z.string().min(1),
        url: z.string().min(1),
        status: z.enum(["published", "fallback", "mock_published"]),
        /** Tool Gateway 实际命中：`mcp` | `lark_cli` | `openapi` */
        artifactSource: z.enum(["mcp", "lark_cli", "openapi"]).optional(),
      }),
    )
    .default([]),
});

export type FinalDeliverable = z.infer<typeof FinalDeliverableSchema>;

export const MemoryUpdateSchema = z.object({
  updated: z.boolean(),
  learnedPreferences: z.array(z.string()).default([]),
  editSignals: z
    .array(
      z.object({
        signalType: z.enum(["manual_edit", "ai_partial_rewrite", "template_preference"]),
        sectionHeading: z.string().optional(),
      }),
    )
    .default([]),
});

export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

export const ResourcePoolChangeSchema = z.object({
  addedResourceIds: z.array(z.string()).default([]),
  updatedResourceIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

export type ResourcePoolChange = z.infer<typeof ResourcePoolChangeSchema>;

export const QualityBaselineSchema = z.object({
  source: z.literal("heuristic_v1").default("heuristic_v1"),
  sectionCoverage: z.number().min(0).max(1),
  templateStructureCoverage: z.number().min(0).max(1),
  artifactReadinessScore: z.number().min(0).max(1),
  templateElementHits: z.object({
    chart: z.number().int().min(0),
    timeline: z.number().int().min(0),
    gantt: z.number().int().min(0),
    table: z.number().int().min(0),
    bulletList: z.number().int().min(0),
  }),
  notes: z.array(z.string()).default([]),
});

export type QualityBaseline = z.infer<typeof QualityBaselineSchema>;
