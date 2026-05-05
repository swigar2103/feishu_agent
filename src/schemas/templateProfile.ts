import { z } from "zod";

/** Word 导出映射（B 阶段）：按小节标题子串选用标题层级 / 编号列表 */
export const TemplateWordExportHintsSchema = z.object({
  sectionHeadingLevels: z
    .array(
      z.object({
        headingIncludes: z.string(),
        level: z.enum(["TITLE", "H1", "H2", "H3"]),
      }),
    )
    .optional(),
  /** 小节标题包含以下任一字串时，正文行拆成编号列表 */
  numberedListForSectionsIncluding: z.array(z.string()).default([]),
  /** 预留：仓库内 dotx 相对路径，未来可做 OOXML 合并 */
  dotxRelativePath: z.string().optional(),
});

/** A+C：从模板蒸馏出的结构化骨架 + 文风约束 */
export const TemplateProfileSchema = z.object({
  version: z.number().int().positive().default(1),
  resourceId: z.string().optional(),
  /** 生成标题模板，如 {{汇报周期}}工作报告 */
  titlePattern: z.string().optional(),
  /** 必须与 Writer sections heading 顺序一致（小节原文标题，含【】） */
  sectionOrder: z.array(z.string()).min(1),
  fixedLabels: z.array(z.string()).default([]),
  listPatterns: z
    .array(
      z.object({
        underSection: z.string(),
        formatDescription: z.string(),
        placeholderHints: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  /** C：文风规则（不含敏感专有名词） */
  styleRules: z.array(z.string()).default([]),
  /** C：禁止写入的正文模式 / 示例话题关键词 */
  forbiddenPatterns: z.array(z.string()).default([]),
  anonymizedStyleSample: z.string().optional(),
  slotHints: z
    .array(
      z.object({
        slotId: z.string(),
        sectionHeading: z.string(),
        description: z.string(),
      }),
    )
    .default([]),
  wordExportHints: TemplateWordExportHintsSchema.optional(),
});

export const TemplateDistillationSchema = z.object({
  profilesByResourceId: z.record(z.string(), TemplateProfileSchema),
});

export type TemplateProfile = z.infer<typeof TemplateProfileSchema>;
export type TemplateDistillation = z.infer<typeof TemplateDistillationSchema>;
