import { z } from "zod";
import { TemplateDistillationSchema } from "./templateProfile.js";

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

export const RetrievalContextSchema = z.object({
  matchedSkill: SkillSchema,
  userMemory: z.object({
    preferredTone: z.string().optional(),
    preferredStructure: z.array(z.string()).optional().default([]),
    commonTerms: z.array(z.string()).optional().default([]),
    styleNotes: z.array(z.string()).optional().default([]),
  }),
  projectContext: z.array(
    z.object({
      sourceId: z.string(),
      sourceType: z.enum(["message", "doc", "table", "history", "calendar", "external", "im"]),
      content: z.string(),
    })
  ).default([]),
  glossary: z.array(z.string()).default([]),
  styleHints: z.array(z.string()).default([]),
  /** A/B/C：模板蒸馏画像（按资源池文档 id） */
  templateDistillation: TemplateDistillationSchema.optional(),
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

export const WriterInputSchema = z.object({
  userRequest: UserRequestSchema,
  taskPlan: TaskPlanSchema,
  retrievalContext: RetrievalContextSchema,
});

export type WriterInput = z.infer<typeof WriterInputSchema>;

export const WriterOutputSchema = z.object({
  title: z.string().transform((s) => s.trim() || "未命名报告"),
  summary: z.string().transform((s) => s.trim() || "（摘要待补充）"),
  sections: z.array(
    z.object({
      heading: z.string().transform((s) => s.trim() || "（未命名小节）"),
      content: z
        .string()
        .transform(
          (s) =>
            s.trim() ||
            "（本节暂无内容，请在 prompt 中补充本周事实后重试）",
        ),
    }),
  ),
  chartSuggestions: z
    .array(
      z.object({
        type: z.string().transform((s) => s.trim() || "chart"),
        title: z.string().transform((s) => s.trim() || "图表"),
        purpose: z.string().transform((s) => s.trim() || "说明待定"),
        dataHint: z.string().transform((s) => s.trim() || "数据待定"),
      }),
    )
    .default([]),
  openQuestions: z
    .array(z.string())
    .optional()
    .transform((rows) =>
      (rows ?? []).map((s) => s.trim()).filter((s) => s.length > 0),
    ),
});

export type WriterOutput = z.infer<typeof WriterOutputSchema>;

export type { TemplateProfile, TemplateDistillation } from "./templateProfile.js";
export {
  TemplateProfileSchema,
  TemplateDistillationSchema,
  TemplateWordExportHintsSchema,
} from "./templateProfile.js";