import { z } from "zod";

/** B3 输出：从「摘要」拉齐到「可用的详情与正文」（结构贴近真实检索，当前数据来自 Mock） */

export const HydratedDocumentChunkSchema = z.object({
  resourceId: z.string(),
  title: z.string(),
  outline: z.array(z.string()).default([]),
  /** 文档正文片段（可由飞书多块拼接；mock 为单一大段 Markdown） */
  body: z.string().min(1),
});

export const HydratedContactDetailSchema = z.object({
  resourceId: z.string(),
  name: z.string(),
  detailText: z.string(),
});

export const HydratedProjectDetailSchema = z.object({
  resourceId: z.string(),
  name: z.string(),
  detailText: z.string(),
});

export const HydratedPersonaBriefSchema = z.object({
  userId: z.string(),
  briefingText: z.string(),
});

export const HydratedTaskContextPackSchema = z.object({
  /** 对齐 Planner / 追踪：对应一次筛选结果（便于 B4 归因） */
  screeningSignature: z.string().optional(),
  documents: z.array(HydratedDocumentChunkSchema),
  contacts: z.array(HydratedContactDetailSchema),
  projects: z.array(HydratedProjectDetailSchema),
  personas: z.array(HydratedPersonaBriefSchema).default([]),
  debugNotes: z.array(z.string()).default([]),
});

export type HydratedTaskContextPack = z.infer<typeof HydratedTaskContextPackSchema>;
