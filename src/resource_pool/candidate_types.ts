import { z } from "zod";

export const ResourceKindSchema = z.enum(["document", "contact", "project", "persona"]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** B2 → B3/B4：候选条目（不包含正文，仅存池内标识与粗打分） */
export const ResourceCandidateRefSchema = z.object({
  kind: ResourceKindSchema,
  /** document/contact/project：业务 id；persona：等价于 PersonaSummary.userId */
  id: z.string().min(1),
  coarseScore: z.number(),
});
export type ResourceCandidateRef = z.infer<typeof ResourceCandidateRefSchema>;

export const ResourceScreeningTraceSchema = z.object({
  /** 抽取/匹配到的信号（关键词片段、Planner 对齐字段），便于调试与 A/C 对齐展示 */
  keywordSignals: z.array(z.string()).default([]),
  coarseCounts: z
    .object({
      documents: z.number(),
      contacts: z.number(),
      projects: z.number(),
      personas: z.number(),
    })
    .optional(),
});

export const ResourceScreeningResultSchema = z.object({
  candidates: z.array(ResourceCandidateRefSchema),
  llmFallbackUsed: z.boolean().default(false),
  trace: ResourceScreeningTraceSchema.default({}),
});
export type ResourceScreeningResult = z.infer<typeof ResourceScreeningResultSchema>;
