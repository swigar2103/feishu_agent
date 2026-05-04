import { z } from "zod";

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
  /** 用户 @ 的资源 id（须存在于当前资源池），软偏好：筛选时加权 */
  mentionedResourceIds: z.array(z.string()).optional().default([]),
  /** 对话模式中由服务端注入：上一轮产物摘要，供增量修订 */
  chatPriorArtifactDigest: z.string().optional(),
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