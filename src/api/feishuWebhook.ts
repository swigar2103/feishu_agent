import type { FastifyInstance } from "fastify";
import {
  feishuVerificationTokenMatches,
  takeUrlVerificationChallenge,
} from "../integrations/feishu/urlVerification.js";
import { WebhookBodySchema } from "../schemas/feishuWebhookBody.js";
import { logger } from "../shared/logger.js";

/**
 * 飞书事件订阅回调：与 report/phase1 分离，保证 Vercel 冷启动时尽快可答 url_verification。
 */
export async function registerFeishuWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.head("/api/feishu/webhook", async (_request, reply) => {
    return reply.status(204).send();
  });

  app.post("/api/feishu/webhook", async (request, reply) => {
    const verifyChallenge = takeUrlVerificationChallenge(request.body);
    if (verifyChallenge) {
      if (!feishuVerificationTokenMatches(request.body)) {
        logger.warn(
          "[feishu webhook] url_verification token 与 FEISHU_VERIFICATION_TOKEN 不一致或未带 token",
        );
        return reply.status(403).send({ message: "verification token mismatch" });
      }
      logger.info("[feishu webhook] url_verification ok");
      return reply.send({ challenge: verifyChallenge });
    }

    const webhookParse = WebhookBodySchema.safeParse(request.body);
    if (!webhookParse.success) {
      return reply.status(400).send({ message: "invalid body" });
    }
    const body = webhookParse.data;

    const { continueFeishuWebhookAfterChallenge } = await import("./feishuWebhookDispatch.js");
    await continueFeishuWebhookAfterChallenge(body, reply);
  });
}
