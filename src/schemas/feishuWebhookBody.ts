import { z } from "zod";

/**
 * 飞书事件体（明文；encrypt 占位提示）
 */
export const WebhookBodySchema = z
  .object({
    type: z.string().optional(),
    challenge: z.string().optional(),
    token: z.string().optional(),
    schema: z.string().optional(),
    encrypt: z.string().optional(),
    header: z.record(z.unknown()).optional(),
    event: z.unknown().optional(),
  })
  .passthrough();

export type FeishuWebhookBody = z.infer<typeof WebhookBodySchema>;
