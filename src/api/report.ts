import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { UserRequestSchema } from "../schemas/index.js";
import { GenerateReportResponseSchema } from "../types/contracts.js";
import { createFeishuUserAuthorizeSession } from "../integrations/feishu/userOAuthAuthorizeFlow.js";
import { getErrorMessage, summarizeError } from "../shared/errorSummary.js";
import {
  getPipelineProgressSnapshot,
  subscribePipelineProgress,
} from "../services/progress/pipelineProgress.js";

function maybeBuildOAuthHint(error: unknown, userId?: string): { oauthRequired: true; authUrl: string } | null {
  if (!userId) return null;
  const msg = error instanceof Error ? error.message : String(error);
  if (!msg.includes("无有效飞书用户访问令牌")) return null;
  try {
    const { authUrl } = createFeishuUserAuthorizeSession({ userId });
    return { oauthRequired: true, authUrl };
  } catch {
    return null;
  }
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/report/progress", async (request, reply) => {
    const query = UserRequestSchema.pick({ sessionId: true }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ message: "invalid query", issues: query.error.issues });
    }
    const { sessionId } = query.data;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
    for (const event of getPipelineProgressSnapshot(sessionId)) {
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = subscribePipelineProgress(sessionId, (event) => {
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      reply.raw.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }, 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.post("/generate-report", async (request, reply) => {
    let parsedUserId: string | undefined;
    try {
      const userRequest = UserRequestSchema.parse(request.body);
      parsedUserId = userRequest.userId;
      const { runReportPipeline } = await import("../services/reportPipeline.js");
      const result = await runReportPipeline(userRequest);
      const response = GenerateReportResponseSchema.parse(result);
      return reply.send(response);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          message: "请求参数或流程输出校验失败",
          issues: error.issues,
        });
      }
      request.log.error(
        {
          errorMessage: getErrorMessage(error),
          errorSummary: summarizeError(error),
        },
        "generate-report failed",
      );
      const oauthHint = maybeBuildOAuthHint(error, parsedUserId);
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
        ...(oauthHint ?? {}),
      });
    }
  });

  app.post("/generate-report-docx", async (request, reply) => {
    let parsedUserId: string | undefined;
    try {
      const userRequest = UserRequestSchema.parse(request.body);
      parsedUserId = userRequest.userId;
      const { runReportPipeline } = await import("../services/reportPipeline.js");
      const { generateReportDocxBuffer, pickPrimaryTemplateProfile } = await import(
        "../services/wordExport.js"
      );
      const { matchTemplateSkill } = await import(
        "../services/agent/templateSkillStore.js"
      );
      const result = await runReportPipeline({
        ...userRequest,
        outputFormat: "word",
      });

      // 匹配用户模板，获取 dotxRelativePath 与 assetDataSnapshots
      const tplMatch = matchTemplateSkill({
        intent: result.intent ?? { taskIntent: "analysis_report", reportType: "analysis_report", industry: "general", outputKind: "doc", initialGaps: [], confidence: 0.5 },
        prompt: userRequest.prompt,
        userId: userRequest.userId,
      });

      const file = await generateReportDocxBuffer({
        report: result.report,
        draft: result.draft,
        taskPlan: result.taskPlan,
        debugTrace: result.debugTrace,
        templateProfile: pickPrimaryTemplateProfile(
          result.templateDistillation?.profilesByResourceId,
        ),
        templateId: tplMatch?.template.id,
        reportType: tplMatch?.selectedSkill.reportType ?? result.taskPlan?.reportType,
        assetDataSnapshots: tplMatch?.assetDataSnapshots ?? [],
      });
      const filename = `report-${userRequest.sessionId}.docx`;
      reply.header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(file);
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          message: "请求参数校验失败",
          issues: error.issues,
        });
      }
      request.log.error(
        {
          errorMessage: getErrorMessage(error),
          errorSummary: summarizeError(error),
        },
        "generate-report-docx failed",
      );
      const oauthHint = maybeBuildOAuthHint(error, parsedUserId);
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
        ...(oauthHint ?? {}),
      });
    }
  });

}
