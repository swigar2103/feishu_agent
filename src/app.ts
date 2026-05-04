import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { registerFeishuWebhookRoutes } from "./api/feishuWebhook.js";
import { env } from "./config/env.js";
import { registerChatRoutes } from "./api/chat.js";
import { logger } from "./shared/logger.js";

async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  /**
   * 飞书 url_verification：webhook 路由须最先注册。
   * report / phase1 须在 listen() 之前注册（Fastify listen 后无法再 add route），仍用动态 import 避免顶层静态拉满 LangGraph。
   */
  await registerFeishuWebhookRoutes(app);
  await registerChatRoutes(app);

  try {
    const { registerReportRoutes } = await import("./api/report.js");
    await registerReportRoutes(app);
    logger.info("report routes registered");
  } catch (error) {
    logger.error("registerReportRoutes 失败（webhook/UI 仍可用）", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const { registerPhase1Routes } = await import("./api/phase1.js");
    await registerPhase1Routes(app);
    logger.info("phase1 routes registered");
  } catch (error) {
    logger.error("registerPhase1Routes 失败（webhook/UI 仍可用）", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  app.get("/healthz", async () => ({ ok: true }));

  const webRoot = path.resolve(process.cwd(), "src", "web");
  app.get("/", async (_, reply) => {
    const html = await readFile(path.join(webRoot, "chat.html"), "utf-8");
    reply.type("text/html; charset=utf-8");
    return reply.send(html);
  });
  app.get("/chat", async (_, reply) => reply.redirect("/", 302));
  app.get("/chat.css", async (_, reply) => {
    const css = await readFile(path.join(webRoot, "chat.css"), "utf-8");
    reply.type("text/css; charset=utf-8");
    return reply.send(css);
  });
  app.get("/chat.js", async (_, reply) => {
    const js = await readFile(path.join(webRoot, "chat.js"), "utf-8");
    reply.type("application/javascript; charset=utf-8");
    return reply.send(js);
  });

  return app;
}

async function start(): Promise<void> {
  let app;
  try {
    app = await buildApp();
    await app.listen({ host: env.HOST, port: env.PORT });
    logger.info("server started", { host: env.HOST, port: env.PORT });
  } catch (error) {
    logger.error("server failed to start（含 webhook / 路由注册阶段）", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
    return;
  }
}

start();
