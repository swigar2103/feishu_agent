import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { UserRequestSchema } from "../schemas/index.js";
import { runReportPipeline } from "../services/reportPipeline.js";
import { generateReportDocxBuffer, pickPrimaryTemplateProfile } from "../services/wordExport.js";
import { GenerateReportResponseSchema } from "../types/contracts.js";

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/generate-report", async (request, reply) => {
    try {
      const userRequest = UserRequestSchema.parse(request.body);
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
      const result = await runReportPipeline({
        ...userRequest,
        outputFormat: "word",
      });
      const file = await generateReportDocxBuffer({
        report: result.report,
        taskPlan: result.taskPlan,
        debugTrace: result.debugTrace,
        templateProfile: pickPrimaryTemplateProfile(
          result.templateDistillation?.profilesByResourceId,
        ),
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
