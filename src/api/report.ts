import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { UserRequestSchema, type WriterOutput } from "../schemas/index.js";
import { runReportPipeline } from "../services/reportPipeline.js";
import { generateReportDocxBuffer, pickPrimaryTemplateProfile } from "../services/wordExport.js";
import { GenerateReportResponseSchema } from "../types/contracts.js";

function buildDemoWriterOutput(docUrl: string): WriterOutput {
  return {
    title: "演示文档",
    summary: `固定演示稿（已跳过检索与生成管线）：${docUrl}`,
    sections: [{ heading: "文档链接", content: docUrl }],
    chartSuggestions: [],
    openQuestions: [],
  };
}

function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/generate-report", async (request, reply) => {
    try {
      const userRequest = UserRequestSchema.parse(request.body);
      if (env.REPORT_PIPELINE_DEMO_SKIP) {
        await sleepMs(env.REPORT_PIPELINE_DEMO_DELAY_MS);
        return reply.send({ url: env.REPORT_PIPELINE_DEMO_URL });
      }
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
      request.log.error({ error }, "generate-report failed");
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
      });
    }
  });

  app.post("/generate-report-docx", async (request, reply) => {
    try {
      const userRequest = UserRequestSchema.parse(request.body);
      let file: Buffer;
      if (env.REPORT_PIPELINE_DEMO_SKIP) {
        await sleepMs(env.REPORT_PIPELINE_DEMO_DELAY_MS);
        file = await generateReportDocxBuffer({
          report: buildDemoWriterOutput(env.REPORT_PIPELINE_DEMO_URL),
        });
      } else {
        const result = await runReportPipeline({
          ...userRequest,
          outputFormat: "word",
        });
        file = await generateReportDocxBuffer({
          report: result.report,
          taskPlan: result.taskPlan,
          debugTrace: result.debugTrace,
          templateProfile: pickPrimaryTemplateProfile(
            result.templateDistillation?.profilesByResourceId,
          ),
        });
      }
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
      request.log.error({ error }, "generate-report-docx failed");
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "内部错误",
      });
    }
  });

  app.get("/mock/im-contacts", async () => {
    return {
      contacts: [
        { id: "u_alice", name: "Alice", role: "项目经理" },
        { id: "u_bob", name: "Bob", role: "数据分析师" },
        { id: "u_cindy", name: "Cindy", role: "业务负责人" },
      ],
    };
  });
}
