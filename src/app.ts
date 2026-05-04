import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./config/env.js";
import { registerChatRoutes } from "./api/chat.js";
import { registerPhase1Routes } from "./api/phase1.js";
import { registerReportRoutes } from "./api/report.js";
import { logger } from "./shared/logger.js";

async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  await registerReportRoutes(app);
  await registerPhase1Routes(app);
  await registerChatRoutes(app);
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
  try {
    const app = await buildApp();
    await app.listen({ host: env.HOST, port: env.PORT });
    logger.info("server started", { host: env.HOST, port: env.PORT });
  } catch (error) {
    logger.error("server failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

start();
