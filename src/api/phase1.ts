import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { assertFeishuMvpConfig, getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { buildResolvedCard } from "../integrations/feishu/cards.js";
import { updateCardMessage } from "../integrations/feishu/imMessage.js";
import { runResourceDebugCheck } from "../integrations/feishu/probes.js";
import { FeishuMcpAdapter } from "../services/toolGateway/feishuMcpAdapter.js";
import { toolGateway } from "../services/toolGateway/gateway.js";
import { logger } from "../shared/logger.js";
import { listUserOAuthSummaries } from "../storage/userOAuthStore.js";

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

    const messageId = body.event?.open_message_id ?? body.open_message_id ?? "";
    const action = body.event?.action?.value;
    const actionName =
      action && typeof action === "object" && typeof action.action === "string"
        ? action.action
        : "";
    if (!messageId || !actionName) {
      return reply.status(200).send({ message: "ok" });
    }

    try {
      const c = getFeishuMvpConfig();
      if (actionName === "mark_done") {
        await updateCardMessage(c, {
          messageId,
          card: buildResolvedCard(),
        });
      } else if (actionName === "continue_generate") {
        await updateCardMessage(c, {
          messageId,
          card: {
            schema: "2.0",
            config: { update_multi: true },
            body: {
              direction: "vertical",
              elements: [
                {
                  tag: "markdown",
                  content: "已收到“继续生成”操作，请在会话中补充你的新要求（例如：加强数据对比、增加风险章节）。",
                },
              ],
            },
          },
        });
      } else if (actionName === "need_more_info") {
        await updateCardMessage(c, {
          messageId,
          card: {
            schema: "2.0",
            config: { update_multi: true },
            body: {
              direction: "vertical",
              elements: [
                {
                  tag: "markdown",
                  content: "请直接在会话中补充信息：时间范围、目标受众、重点指标、输出格式偏好等。",
                },
              ],
            },
          },
        });
      }
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

  /**
   * 本地联调一键自检：环境变量 + 用户 OAuth 落盘概况（不返回任何 token）。
   * GET /api/phase1/setup-check
   */
  app.get("/api/phase1/setup-check", async (_request, reply) => {
    const c = getFeishuMvpConfig();
    const redirect = env.FEISHU_USER_OAUTH_REDIRECT_URI.trim();
    const callbackPath = "/api/feishu/auth/callback";
    const oauthSummaries = listUserOAuthSummaries();

    let redirectParse: { origin: string; pathname: string } | null = null;
    if (redirect) {
      try {
        const u = new URL(redirect);
        redirectParse = { origin: u.origin, pathname: u.pathname };
      } catch {
        /* 由 nextSteps 提示 */
      }
    }

    const uatNeedOAuth =
      env.FEISHU_MCP_IDENTITY === "uat" ||
      env.FEISHU_IDENTITY_MODE === "user_default" ||
      oauthSummaries.length > 0;

    const nextSteps: string[] = [];
    if (!env.FEISHU_MCP_URL.trim()) {
      nextSteps.push("在 .env 中配置 FEISHU_MCP_URL 才能走远程 MCP。");
    }
    if (redirect && !redirectParse) {
      nextSteps.push("FEISHU_USER_OAUTH_REDIRECT_URI 当前值不是合法 URL，请修正。");
    }
    if (!redirect) {
      nextSteps.push(
        "在 .env 中配置 FEISHU_USER_OAUTH_REDIRECT_URI（须与开放平台「重定向 URL」完全一致），本地示例：http://127.0.0.1:3000/api/feishu/auth/callback",
      );
    } else if (redirectParse) {
      const pathNorm = redirectParse.pathname.replace(/\/$/, "") || "/";
      if (pathNorm !== callbackPath) {
        nextSteps.push(
          `回调路径应为 ${callbackPath}（当前为 ${redirectParse.pathname}），须与代码中 feishuAuth 路由一致。`,
        );
      }
    }
    if (env.FEISHU_MCP_IDENTITY === "uat") {
      if (oauthSummaries.length === 0 || !oauthSummaries.some((s) => s.authorized)) {
        nextSteps.push(
          "FEISHU_MCP_IDENTITY=uat：请浏览器打开 GET /api/feishu/auth/start?userId=<与报告请求相同的 id> 完成授权，再用本接口确认 authorized=true。",
        );
      }
    }
    if (env.FEISHU_RESOURCE_POOL_SOURCE === "real" && !env.FEISHU_RESOURCE_FOLDER_TOKEN.trim()) {
      nextSteps.push("FEISHU_RESOURCE_POOL_SOURCE=real 时需配置 FEISHU_RESOURCE_FOLDER_TOKEN。");
    }
    if (redirect && redirectParse) {
      try {
        const u = new URL(redirect);
        if (u.port && Number(u.port) !== env.PORT) {
          nextSteps.push(
            `OAuth 回调 URL 端口为 ${u.port}，与当前服务 PORT=${env.PORT} 不一致时请改 .env 中 PORT 或回调 URL。`,
          );
        }
      } catch {
        /* 已在上方处理非法 URL */
      }
    }

    return reply.send({
      ok: true,
      server: { port: env.PORT, host: env.HOST },
      feishu: {
        appIdConfigured: Boolean(c.appId?.trim()),
        appSecretConfigured: Boolean(c.appSecret?.trim()),
      },
      mcp: {
        urlConfigured: Boolean(env.FEISHU_MCP_URL.trim()),
        identity: env.FEISHU_MCP_IDENTITY,
        uatNote:
          env.FEISHU_MCP_IDENTITY === "uat"
            ? "tools/call 使用 X-Lark-MCP-UAT；需有效用户 OAuth，且业务请求 userId 与授权时一致。"
            : "tools/call 使用 X-Lark-MCP-TAT（租户应用令牌）。",
      },
      userOAuth: {
        redirectUriConfigured: Boolean(redirect),
        redirect: redirectParse,
        redirectUri: redirect || null,
        sessions: oauthSummaries,
      },
      resourcePool: {
        source: env.FEISHU_RESOURCE_POOL_SOURCE,
        folderTokenConfigured: Boolean(env.FEISHU_RESOURCE_FOLDER_TOKEN.trim()),
      },
      phase1TemplatePipeline: {
        templateConfigured: Boolean(c.templateFileToken?.trim()),
        targetFolderConfigured: Boolean(c.targetFolderToken?.trim()),
        note: "仅影响 Phase1 /api/phase1/mvp；与 /generate-report 的 MCP 检索可独立配置。",
      },
      hints: {
        uatNeedOAuthChannel: uatNeedOAuth,
      },
      nextSteps,
    });
  });

  /**
   * MCP 健康与工具列表探测（§12.5 P1）
   * GET /api/phase1/mcp-check
   */
  app.get("/api/phase1/mcp-check", async (request, reply) => {
    const urlConfigured = Boolean(env.FEISHU_MCP_URL.trim());
    const allowed = env.FEISHU_MCP_ALLOWED_TOOLS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const q = request.query as Record<string, unknown>;
    const userIdRaw = q.userId;
    const listUserId =
      typeof userIdRaw === "string"
        ? userIdRaw.trim()
        : Array.isArray(userIdRaw) && typeof userIdRaw[0] === "string"
          ? userIdRaw[0].trim()
          : "";
    if (!urlConfigured) {
      return reply.send({
        ok: false,
        mcpUrlConfigured: false,
        message: "FEISHU_MCP_URL 未配置，将 skip mcp",
        allowedToolsInEnv: allowed,
      });
    }
    const adapter = new FeishuMcpAdapter();
    const toolsList = await adapter.listRemoteToolNames(listUserId ? { userId: listUserId } : undefined);
    const remote = toolsList.tools ?? [];
    const coverage = allowed.map((name) => ({
      name,
      listed: remote.includes(name),
    }));
    const missingAllowed = toolsList.ok
      ? coverage.filter((c) => !c.listed).map((c) => c.name)
      : [];
    return reply.send({
      ok: toolsList.ok && missingAllowed.length === 0,
      mcpUrlConfigured: true,
      mcpIdentity: env.FEISHU_MCP_IDENTITY,
      listUsedUserId: listUserId || null,
      toolsList,
      allowedToolsInEnv: allowed,
      remoteToolCount: remote.length,
      coverage: toolsList.ok ? coverage : undefined,
      missingAllowedInRemoteList: missingAllowed.length > 0 ? missingAllowed : undefined,
    });
  });

  /**
   * 联调：直接走 toolGateway.searchDocuments（MCP 下为 X-Lark-MCP-TAT 或 UAT，见 FEISHU_MCP_IDENTITY）。
   * GET /api/phase1/mcp-search-doc?query=院周会&userId=<与 OAuth 一致>
   * 返回条目中 `source` 为 `mcp` 表示本次结果来自 MCP；若为 `lark_cli` / `openapi` 表示已降级。
   */
  app.get("/api/phase1/mcp-search-doc", async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const raw = q.query ?? q.q ?? "";
    const query =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw) && typeof raw[0] === "string"
          ? raw[0]
          : "";
    const userIdRaw = q.userId;
    const userId =
      typeof userIdRaw === "string"
        ? userIdRaw.trim()
        : Array.isArray(userIdRaw) && typeof userIdRaw[0] === "string"
          ? userIdRaw[0].trim()
          : "";
    const trimmed = query.trim();
    if (!trimmed) {
      return reply.status(400).send({
        ok: false,
        message: "缺少 query 参数，例如 ?query=院周会",
      });
    }
    try {
      const ctx = userId ? { userId } : undefined;
      const docs = await toolGateway.searchDocuments(trimmed, ctx);
      const sources = [...new Set(docs.map((d) => d.source).filter(Boolean))];
      return reply.send({
        ok: true,
        query: trimmed,
        mcpIdentity: env.FEISHU_MCP_IDENTITY,
        userId: userId || null,
        count: docs.length,
        sources,
        documents: docs.map((d) => ({
          id: d.id,
          title: d.title,
          summary: d.summary,
          url: d.url,
          source: d.source,
        })),
      });
    } catch (error) {
      logger.error("mcp-search-doc failed", { error });
      return reply.status(502).send({
        ok: false,
        query: trimmed,
        message: error instanceof Error ? error.message : String(error),
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
