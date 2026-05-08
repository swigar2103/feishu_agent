import { z } from "zod";

export const SourceRefSchema = z.object({
  sourceType: z.enum(["doc", "chat", "table", "message", "file", "folder", "unknown"]).default("unknown"),
  docToken: z.string().optional(),
  chatId: z.string().optional(),
  msgId: z.string().optional(),
  fileToken: z.string().optional(),
  rangeHint: z.string().optional(),
  url: z.string().optional(),
});

export const TimeRangeSchema = z
  .object({
    start: z.string().optional(),
    end: z.string().optional(),
  })
  .default({});

const BaseMemoryObjectSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  layer: z.enum(["L1", "L2", "L3"]),
  wingId: z.string().optional(),
  roomId: z.string().optional(),
  drawerId: z.string().optional(),
  owner: z.string().min(1),
  projectTag: z.string().default("default"),
  timeRange: TimeRangeSchema,
  keywords: z.array(z.string()).default([]),
  qualityScore: z.number().min(0).max(1).default(0.5),
  sourceRef: SourceRefSchema,
});

export const L1CatalogObjectSchema = BaseMemoryObjectSchema.extend({
  layer: z.literal("L1"),
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const L2IndexObjectSchema = BaseMemoryObjectSchema.extend({
  layer: z.literal("L2"),
  parentId: z.string().optional(),
  title: z.string().min(1),
  structureSummary: z.string().min(1),
});

export const L3DetailPointerObjectSchema = BaseMemoryObjectSchema.extend({
  layer: z.literal("L3"),
  parentId: z.string().optional(),
  pointerType: z.enum(["doc_snippet", "message_snippet", "table_region", "unknown"]).default("unknown"),
  pointerSummary: z.string().min(1),
  snippet: z.string().optional(),
});

export const HmrsMemoryObjectSchema = z.discriminatedUnion("layer", [
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
  L3DetailPointerObjectSchema,
]);

export const HmrsRelationSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  relationType: z.enum(["contains", "references", "derived_from", "similar_to"]).default("contains"),
});

export type SourceRef = z.infer<typeof SourceRefSchema>;
export type HmrsRelation = z.infer<typeof HmrsRelationSchema>;
export type L1CatalogObject = z.infer<typeof L1CatalogObjectSchema>;
export type L2IndexObject = z.infer<typeof L2IndexObjectSchema>;
export type L3DetailPointerObject = z.infer<typeof L3DetailPointerObjectSchema>;
export type HmrsMemoryObject = z.infer<typeof HmrsMemoryObjectSchema>;
