import { z } from "zod";
import {
  ReviewReportSchema,
  TaskIntentSchema,
  TaskPlanSchema,
  UserMemorySchema,
  WriterOutputSchema,
} from "../schemas/index.js";

export const GenerateReportResponseSchema = z.object({
  selectedSkillId: z.string().optional(),
  taskPlan: TaskPlanSchema.optional(),
  taskIntent: TaskIntentSchema.optional(),
  followUpQuestions: z.array(z.string()).optional(),
  reviewNotes: z.array(z.string()).optional(),
  reviewReport: ReviewReportSchema.optional(),
  revisionCount: z.number().int().nonnegative().optional(),
  outputTargets: z.array(z.enum(["feishu_doc", "bitable", "slides"])).optional(),
  report: WriterOutputSchema,
  debugTrace: z.array(z.string()).optional(),
  userMemorySnapshot: UserMemorySchema.optional(),
});

export type GenerateReportResponse = z.infer<typeof GenerateReportResponseSchema>;
