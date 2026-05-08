import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertFeishuMvpConfig, getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { sendTextMessage } from "../integrations/feishu/imMessage.js";
import { runResourceDebugCheck } from "../integrations/feishu/probes.js";
import { handleBotMessageText } from "../phase1/botHandler.js";
import { runPhase1Mvp } from "../phase1/pipeline.js";
import { logger } from "../shared/logger.js";

/** 演示：webhook 收到用户 IM 后直接回发该云文档 URL（不走 Phase1 / 报告生成）。 */
const FEISHU_WEBHOOK_RETURN_DOCX_URL =
  "https://jcneyh7qlo8i.feishu.cn/docx/YT5TdRz1CoWgyExOqRVcWvH0nzb";

function extractUrlVerificationChallenge(body: Record<string, unknown>): string | null {
  if (typeof body.challenge === "string" && body.challenge.length > 0) {
    return body.challenge;
  }
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return body.challenge;
  }
  const ev = body.event;
  if (ev && typeof ev === "object" && ev !== null && "challenge" in ev) {
    const c = (ev as { challenge?: unknown }).challenge;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return null;
}

/** 从明文 im.message.receive_v1（及 2.0 结构）中取 chat_id，忽略应用自身消息。 */
function tryParseUserImChatId(body: Record<string, unknown>): string | null {
  const ev = body.event;
  if (!ev || typeof ev !== "object" || ev === null) return null;
  const event = ev as Record<string, unknown>;
  const sender = event.sender as { sender_type?: string } | undefined;
  if (sender?.sender_type === "app") return null;

  const msg = event.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return null;
  const chatId = msg.chat_id;
  return typeof chatId === "string" && chatId.length > 0 ? chatId : null;
}

const MvpBodySchema = z.object({
  userText: z.string().min(1, "userText 不能为空"),
  /** 发群/会话消息时填 chat_id；不传则看环境变量 FEISHU_IM_NOTIFY_CHAT_ID */
  chatId: z.string().optional(),
});

/**
 * 飞书事件体（只处理最基础的 challenge；加密事件请后续用官方解密）
 */
const WebhookBodySchema = z
  .object({
    type: z.string().optional(),
    challenge: z.string().optional(),
    token: z.string().optional(),
    schema: z.string().optional(),
    /** 飞书 2.0 加密事件体 */
    encrypt: z.string().optional(),
    header: z.record(z.unknown()).optional(),
    event: z.unknown().optional(),
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

  /**
   * 飞书开放平台「事件订阅」配置请求 URL 时的 challenge 验证。
   * 注意：im.message 等事件若开启加密，需在后续版本解密 `encrypt` 字段。
   */
  app.post("/api/feishu/webhook", async (request, reply) => {
    const parsed = WebhookBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid body" });
    }
    const body = parsed.data as Record<string, unknown>;
    const challenge = extractUrlVerificationChallenge(body);
    if (challenge) {
      return reply.send({ challenge });
    }
    if (body.encrypt) {
      return reply.status(200).send({
        message: "已收到加密事件，请在后续版本实现 decrypt（飞书 事件 2.0 文档）",
      });
    }

    const chatId = tryParseUserImChatId(body);
    if (chatId) {
      void (async () => {
        try {
          const c = getFeishuMvpConfig();
          if (!c.appId || !c.appSecret) {
            logger.warn("feishu webhook demo: 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET，未发 IM");
            return;
          }
          await sendTextMessage(c, {
            receiveId: chatId,
            text: FEISHU_WEBHOOK_RETURN_DOCX_URL,
          });
          logger.info("feishu webhook demo: 已回发固定文档 URL", { chatId });
        } catch (error) {
          logger.error("feishu webhook demo: 发送失败", {
            chatId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
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
