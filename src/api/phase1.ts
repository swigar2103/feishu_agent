import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertFeishuMvpConfig, getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { buildResolvedCard } from "../integrations/feishu/cards.js";
import { updateCardMessage } from "../integrations/feishu/imMessage.js";
import { runResourceDebugCheck } from "../integrations/feishu/probes.js";
import { logger } from "../shared/logger.js";

const MvpBodySchema = z.object({
  userText: z.string().min(1, "userText 不能为空"),
  /** 发群/会话消息时填 chat_id；不传则看环境变量 FEISHU_IM_NOTIFY_CHAT_ID */
  chatId: z.string().optional(),
});

const CardCallbackBodySchema = z
  .object({
    challenge: z.string().optional(),
    event: z
      .object({
        action: z
          .object({
            value: z.record(z.unknown()).optional(),
          })
          .optional(),
        open_message_id: z.string().optional(),
      })
      .optional(),
    open_message_id: z.string().optional(),
  })
  .passthrough();

export async function registerPhase1Routes(app: FastifyInstance): Promise<void> {
  /**
   * 本地/联调：手动 POST 即跑通「复制 → 读块 → 按节生成 → 写回 → 可选发群」
   * POST /api/phase1/mvp  JSON { "userText": "…", "chatId"?: "oc_…" }
   */
  app.post("/api/phase1/mvp", async (request, reply) => {
    try {
      const body = MvpBodySchema.parse(request.body);
      const { runPhase1Mvp } = await import("../phase1/pipeline.js");
      const result = await runPhase1Mvp({
        userText: body.userText,
        chatId: body.chatId,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          message: "请求参数不合法",
          issues: error.issues,
        });
      }
      logger.error("phase1 mvp failed", { error });
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
      });
    }
  });

  /** 与 botHandler 命名一致，便于以后机器人路由直连 */
  app.post("/api/phase1/bot-message", async (request, reply) => {
    try {
      const body = MvpBodySchema.parse(request.body);
      const { handleBotMessageText } = await import("../phase1/botHandler.js");
      const result = await handleBotMessageText({
        userText: body.userText,
        chatId: body.chatId,
      });
      return reply.send(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          message: "请求参数不合法",
          issues: error.issues,
        });
      }
      logger.error("phase1 bot-message failed", { error });
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
      });
    }
  });

  app.post("/api/feishu/card-callback", async (request, reply) => {
    const parsed = CardCallbackBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid card callback" });
    }
    const body = parsed.data;
    if (body.challenge) {
      return reply.send({ challenge: body.challenge });
    }

    const messageId =
      body.event?.open_message_id ?? body.open_message_id ?? "";
    const action = body.event?.action?.value;
    const actionName =
      action && typeof action === "object" && typeof action.action === "string"
        ? action.action
        : "";
    if (!messageId || actionName !== "mark_done") {
      return reply.status(200).send({ message: "ok" });
    }

    try {
      const c = getFeishuMvpConfig();
      await updateCardMessage(c, {
        messageId,
        card: buildResolvedCard(),
      });
    } catch (error) {
      logger.error("card callback update failed", { error });
    }
    return reply.status(200).send({ message: "ok" });
  });

  /**
   * 源模板 / 目标文件夹 探针（不调用 drive copy、不跑生成逻辑）
   * GET /api/phase1/debug-resource-check?deleteProbeDoc=true  — 目标探测成功后删临时 docx
   */
  app.get("/api/phase1/debug-resource-check", async (request, reply) => {
    const q = request.query as { deleteProbeDoc?: string };
    const deleteProbeDoc = q.deleteProbeDoc === "1" || q.deleteProbeDoc === "true";
    try {
      const c = getFeishuMvpConfig();
      if (!c.appId || !c.appSecret) {
        return reply.status(400).send({
          message: "需要配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET",
        });
      }
      const out = await runResourceDebugCheck(c, { deleteProbeDoc });
      return reply.send(out);
    } catch (error) {
      logger.error("debug-resource-check failed", { error });
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
      });
    }
  });

  app.get("/api/phase1/config-check", async (_request, reply) => {
    const c = getFeishuMvpConfig();
    const ok = Boolean(
      c.appId && c.appSecret && c.templateFileToken && c.targetFolderToken,
    );
    if (!ok) {
      return reply.send({
        ok: false,
        missing: {
          FEISHU_APP_ID: !c.appId,
          FEISHU_APP_SECRET: !c.appSecret,
          FEISHU_TEMPLATE_FILE_TOKEN: !c.templateFileToken,
          FEISHU_TARGET_FOLDER_TOKEN: !c.targetFolderToken,
        },
      });
    }
    try {
      assertFeishuMvpConfig();
      return reply.send({ ok: true });
    } catch (e) {
      return reply.send({ ok: false, error: String(e) });
    }
  });
}
