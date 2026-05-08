import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HmrsRepository } from "../services/hmrs/hmrsRepository.js";
import { UserDatabaseBootstrapService } from "../services/hmrs/userDatabaseBootstrapService.js";
import { HmrsIngestService } from "../services/hmrs/hmrsIngestService.js";
import { HmrsRefreshService } from "../services/hmrs/hmrsRefreshService.js";
import { TemplateExtractionService } from "../services/hmrs/templateExtractionService.js";

const BootstrapBodySchema = z.object({
  userId: z.string().min(1),
  nickname: z.string().optional(),
});

const IngestBodySchema = z.object({
  userId: z.string().min(1),
  sourceFolderToken: z.string().min(1),
  projectName: z.string().optional(),
  nickname: z.string().optional(),
});

const RootQuerySchema = z.object({
  userId: z.string().min(1),
  nickname: z.string().optional(),
});

const RefreshStatusQuerySchema = z.object({
  userId: z.string().min(1),
  nickname: z.string().optional(),
});

const RefreshBodySchema = z.object({
  userId: z.string().min(1),
  nickname: z.string().optional(),
});

const ExtractTemplateBodySchema = z.object({
  userId: z.string().min(1),
  documentRef: z.string().min(1),
  templateName: z.string().optional(),
});

const ListTemplateQuerySchema = z.object({
  userId: z.string().min(1),
});

export async function registerHmrsRoutes(app: FastifyInstance): Promise<void> {
  const repo = new HmrsRepository();
  const bootstrapSvc = new UserDatabaseBootstrapService(repo);
  const ingestSvc = new HmrsIngestService(repo);
  const refreshSvc = new HmrsRefreshService();
  const templateSvc = new TemplateExtractionService();

  app.post("/api/hmrs/bootstrap", async (request, reply) => {
    const parsed = BootstrapBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid body", issues: parsed.error.issues });
    }
    const result = await bootstrapSvc.bootstrap(parsed.data);
    return reply.send({ ok: true, ...result });
  });

  app.post("/api/hmrs/ingest-folder", async (request, reply) => {
    const parsed = IngestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid body", issues: parsed.error.issues });
    }
    const bootstrap = await bootstrapSvc.bootstrap({
      userId: parsed.data.userId,
      nickname: parsed.data.nickname,
    });
    const result = await ingestSvc.ingestManagedFolder({
      userId: parsed.data.userId,
      hmrsRootToken: bootstrap.rootFolderToken,
      sourceFolderToken: parsed.data.sourceFolderToken,
      projectName: parsed.data.projectName,
    });
    return reply.send({
      ok: true,
      bootstrap,
      ingest: result,
    });
  });

  app.get("/api/hmrs/root", async (request, reply) => {
    const parsed = RootQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    const result = await bootstrapSvc.bootstrap(parsed.data);
    return reply.send({ ok: true, ...result });
  });

  app.post("/api/hmrs/refresh", async (request, reply) => {
    const parsed = RefreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid body", issues: parsed.error.issues });
    }
    const result = await refreshSvc.refreshForUser(parsed.data);
    return reply.send({ ok: true, refresh: result });
  });

  app.get("/api/hmrs/refresh-status", async (request, reply) => {
    const parsed = RefreshStatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    const result = await refreshSvc.getRefreshStatus(parsed.data);
    return reply.send({ ok: true, ...result });
  });

  app.post("/api/hmrs/extract-template", async (request, reply) => {
    const parsed = ExtractTemplateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid body", issues: parsed.error.issues });
    }
    const result = await templateSvc.extractAndStore(parsed.data);
    return reply.send({ ok: true, template: result });
  });

  app.get("/api/hmrs/templates", async (request, reply) => {
    const parsed = ListTemplateQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    const list = templateSvc.listByUser(parsed.data.userId);
    return reply.send({ ok: true, count: list.length, templates: list });
  });

  // ──────────────────────────────────────────────
  // POST /api/hmrs/generate-dotx
  // 为所有已提取模板生成 dotx 母版文件
  // ──────────────────────────────────────────────
  const GenerateDotxBodySchema = z.object({
    force: z.boolean().optional().default(false),
  });

  app.post("/api/hmrs/generate-dotx", async (request, reply) => {
    const parsed = GenerateDotxBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ message: "参数错误", issues: parsed.error.issues });
    }
    try {
      const { readJsonFile } = await import("../services/hmrs/repo/file/fileStorage.js");
      const { generateDotxMasters } = await import("../services/dotxMasterGenerator.js");
      const store = readJsonFile<{ templates: unknown[] }>("hmrs-template-skills.json", { templates: [] });
      const results = await generateDotxMasters(
        store.templates as Parameters<typeof generateDotxMasters>[0],
        { force: parsed.data.force },
      );
      return reply.send({
        ok: true,
        count: results.length,
        results: results.map((r) => ({
          templateId: r.templateId,
          templateName: r.templateName,
          dotxRelativePath: r.dotxRelativePath,
        })),
      });
    } catch (error) {
      request.log.error({ error }, "generate-dotx failed");
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "dotx 生成失败",
      });
    }
  });

  // GET /api/hmrs/dotx-status — 查询 dotx 母版文件是否已生成
  app.get("/api/hmrs/dotx-status", async (_request, reply) => {
    try {
      const { readJsonFile } = await import("../services/hmrs/repo/file/fileStorage.js");
      const { getDotxRelativePath } = await import("../services/dotxMasterGenerator.js");
      const store = readJsonFile<{ templates: Array<{ id: string; templateName: string }> }>(
        "hmrs-template-skills.json",
        { templates: [] },
      );
      const status = store.templates.map((tpl) => {
        const rel = getDotxRelativePath(tpl.id);
        return {
          templateId: tpl.id,
          templateName: tpl.templateName,
          dotxReady: !!rel,
          dotxRelativePath: rel ?? null,
        };
      });
      return reply.send({ ok: true, status });
    } catch (error) {
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "查询失败",
      });
    }
  });
}

