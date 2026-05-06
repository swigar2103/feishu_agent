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
});

export type MemoryUpdate = z.infer<typeof MemoryUpdateSchema>;

export const ResourcePoolChangeSchema = z.object({
  addedResourceIds: z.array(z.string()).default([]),
  updatedResourceIds: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

export type ResourcePoolChange = z.infer<typeof ResourcePoolChangeSchema>;
