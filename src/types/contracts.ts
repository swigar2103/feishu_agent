import { z } from "zod";
import { TaskPlanSchema, WriterOutputSchema } from "../schemas/index.js";
import { TemplateDistillationSchema } from "../schemas/templateProfile.js";

export const GenerateReportResponseSchema = z.object({
  selectedSkillId: z.string().optional(),
  taskPlan: TaskPlanSchema.optional(),
  taskIntent: z.string().optional(),
  followUpQuestions: z.array(z.string()).optional(),
  reviewNotes: z.array(z.string()).optional(),
  outputTargets: z.array(z.enum(["feishu_doc", "bitable", "slides"])).optional(),
  report: WriterOutputSchema,
  debugTrace: z.array(z.string()).optional(),
  templateDistillation: TemplateDistillationSchema.optional(),
});

export type GenerateReportResponse = z.infer<typeof GenerateReportResponseSchema>;
