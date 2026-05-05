import { z } from "zod";

/** 文档摘要（供 B2 粗筛；正文由 B3 / 适配层拉取） */
export const DocumentSummarySchema = z.object({
  id: z.string().min(1),
  /** 自根资源夹向下的文件夹名路径（不含文件名）；mock/老数据可缺省 */
  folderPathSegments: z.array(z.string()).default([]),
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** 飞书 doc token 等占位，B5 真实对接时使用 */
  feishuDocToken: z.string().optional(),
  weight: z.number().default(1),
  updatedAt: z.string().optional(),
});
export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

/** 联系人摘要 */
export const ContactSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().optional(),
  org: z.string().optional(),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
  email: z.string().optional(),
  weight: z.number().default(1),
});
export type ContactSummary = z.infer<typeof ContactSummarySchema>;

/** 项目资料摘要 */
export const ProjectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
  status: z.string().optional(),
  /** 可选：关联文档 id，便于 B4 建立关系 */
  relatedDocumentIds: z.array(z.string()).default([]),
  weight: z.number().default(1),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

/** 用户画像摘要（检索侧可见的一致结构） */
export const PersonaSummarySchema = z.object({
  userId: z.string().min(1),
  preferredTone: z.string().optional(),
  domains: z.array(z.string()).default([]),
  styleNotes: z.array(z.string()).default([]),
  commonTerms: z.array(z.string()).default([]),
  weight: z.number().default(1),
});
export type PersonaSummary = z.infer<typeof PersonaSummarySchema>;

export const ResourcePoolSnapshotSchema = z.object({
  documents: z.array(DocumentSummarySchema),
  contacts: z.array(ContactSummarySchema),
  projects: z.array(ProjectSummarySchema),
  personas: z.array(PersonaSummarySchema),
  meta: z
    .object({
      version: z.string(),
      loadedAt: z.string().optional(),
    })
    .optional(),
});

export type ResourcePoolSnapshot = z.infer<typeof ResourcePoolSnapshotSchema>;

/** 供四类资源共用的轻量查询（关键词匹配 title/summary/name 等可扩展字段） */
export const PoolTextQuerySchema = z.object({
  keyword: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 默认 any：命中任一标签即保留 */
  tagMode: z.enum(["any", "all"]).optional().default("any"),
  limit: z.number().int().positive().optional(),
});

export type PoolTextQuery = z.infer<typeof PoolTextQuerySchema>;
