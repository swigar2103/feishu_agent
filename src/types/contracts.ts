import { z } from "zod";
import { TaskPlanSchema, WriterOutputSchema } from "../schemas/index.js";
import {
  ComplianceReviewResultSchema,
  ExecutionPlanSchema,
  FinalDeliverableSchema,
  IntentResultSchema,
  QualityBaselineSchema,
  MemoryUpdateSchema,
  ResourcePoolChangeSchema,
  SkillMatchSchema,
  StyleReviewResultSchema,
} from "../schemas/agentContracts.js";
import { TemplateDistillationSchema } from "../schemas/templateProfile.js";

export const GenerateReportResponseSchema = z.object({
  selectedSkillId: z.string().optional(),
  intent: IntentResultSchema.optional(),
  skillMatch: SkillMatchSchema.optional(),
  executionPlan: ExecutionPlanSchema.optional(),
  taskPlan: TaskPlanSchema.optional(),
  taskIntent: z.string().optional(),
  followUpQuestions: z.array(z.string()).optional(),
  styleReview: StyleReviewResultSchema.optional(),
  complianceReview: ComplianceReviewResultSchema.optional(),
  reviewNotes: z.array(z.string()).optional(),
  finalDeliverable: FinalDeliverableSchema.optional(),
  memoryUpdate: MemoryUpdateSchema.optional(),
  resourcePoolChange: ResourcePoolChangeSchema.optional(),
  outputTargets: z.array(z.enum(["feishu_doc", "bitable", "slides"])).optional(),
  report: WriterOutputSchema,
  qualityBaseline: QualityBaselineSchema.optional(),
  debugTrace: z.array(z.string()).optional(),
  templateDistillation: TemplateDistillationSchema.optional(),
});

export type GenerateReportResponse = z.infer<typeof GenerateReportResponseSchema>;
