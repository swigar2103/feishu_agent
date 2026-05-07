import { toolGateway } from "../toolGateway/gateway.js";
import { HmrsRepository } from "./hmrsRepository.js";
import { buildDocumentIndexes, buildFolderSummary } from "./summaryBuilder.js";
import { HMRS_FOLDER_NAMES } from "./hmrsStructureBuilder.js";

export type IngestBucketRole = "work_material" | "template_example";

export type IngestResult = {
  ingestedDocs: number;
  folderToken: string;
  roomPath: string;
  bucketRole: IngestBucketRole;
};

const BUCKET_ROLE_LABELS: Record<IngestBucketRole, string> = {
  work_material: "工作资料",
  template_example: "模板样例",
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "default_project";
}

function inferReportType(title: string): string {
  if (/日报/.test(title)) return "daily_report";
  if (/周报/.test(title)) return "weekly_report";
  if (/月报/.test(title)) return "monthly_report";
  if (/会议|纪要/.test(title)) return "meeting_summary";
  if (/方案|提案/.test(title)) return "proposal";
  if (/里程碑|计划/.test(title)) return "project_plan";
  if (/经营|业务/.test(title)) return "biz_weekly";
  return "general";
}

function extractHeadingsFromContent(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s+\S/.test(line))
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

export class HmrsIngestService {
  constructor(private readonly repo: HmrsRepository = new HmrsRepository()) {}

  private readableShortName(input: string): string {
    const cleaned = input.trim().replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
    return cleaned.slice(0, 24) || "未命名来源";
  }

  private async cleanupLegacyArtifacts(input: {
    userId: string;
    drawerToken: string;
    names: string[];
  }): Promise<void> {
    const expected = new Set(input.names);
    if (expected.size <= 0) return;
    const items = await this.repo.listFolderItems(input.userId, input.drawerToken);
    const targets = items.filter((item) => !item.type.toLowerCase().includes("folder") && expected.has(item.name));
    for (const target of targets) {
      await this.repo.deleteFile(input.userId, target.token).catch(() => null);
    }
  }

  async ingestManagedFolder(input: {
    userId: string;
    hmrsRootToken: string;
    sourceFolderToken: string;
    projectName?: string;
    bucketRole?: IngestBucketRole;
    bucketParentPath?: string;
  }): Promise<IngestResult> {
    const bucketRole: IngestBucketRole = input.bucketRole ?? "work_material";
    const bucketLabel = BUCKET_ROLE_LABELS[bucketRole];
    const folderMeta = await this.repo.getFolderMeta(input.userId, input.sourceFolderToken).catch(() => null);
    const sourceFolderName = this.readableShortName(folderMeta?.name ?? input.sourceFolderToken);
    const docs = await this.repo.listDocsInFolder(input.userId, input.sourceFolderToken);
    const isTemplateBucketEarly = (input.bucketRole ?? "work_material") === "template_example";
    const viewed = [];
    for (const doc of docs.slice(0, 30)) {
      const detail = await toolGateway.viewDocument(doc.token, {
        userId: input.userId,
        preferUserScope: true,
      }).catch(() => null);

      // 对模板桶中的每篇文档提取大纲，生成结构化 structureSummary
      let structureSummary: string | undefined;
      if (isTemplateBucketEarly) {
        const outline = await toolGateway.fetchDocumentOutline(doc.token, {
          userId: input.userId,
          preferUserScope: true,
        }).catch(() => [] as string[]);
        if (outline.length > 0) {
          const reportType = inferReportType(doc.title);
          structureSummary = JSON.stringify({ sectionOrder: outline, reportType });
        } else {
          // fallback：从正文中提取 ## 标题行
          const fallbackHeadings = extractHeadingsFromContent(detail?.content ?? detail?.summary ?? "");
          if (fallbackHeadings.length > 0) {
            const reportType = inferReportType(doc.title);
            structureSummary = JSON.stringify({ sectionOrder: fallbackHeadings, reportType });
          }
        }
      }

      viewed.push({
        id: doc.token,
        title: doc.title,
        summary: detail?.summary ?? detail?.content?.slice(0, 240),
        content: detail?.content,
        url: detail?.url,
        source: detail?.source,
        structureSummary,
      });
    }

    const folderSummary = buildFolderSummary({
      folderToken: input.sourceFolderToken,
      docs: viewed,
    });
    const docIndexes = buildDocumentIndexes(viewed);
    const legacyTokenSlug = slugify(input.sourceFolderToken);
    const isTemplateBucket = bucketRole === "template_example";
    const projectRoom = `${slugify(input.projectName ?? "managed_project")}_room`;
    const roomPath = isTemplateBucket && input.bucketParentPath
      ? input.bucketParentPath
      : `${HMRS_FOLDER_NAMES.projectsWing}/${projectRoom}`;
    const summaryDrawerPath = isTemplateBucket
      ? `${roomPath}/${HMRS_FOLDER_NAMES.structureDrawer}`
      : `${roomPath}/summary_drawer`;
    const docsDrawerPath = isTemplateBucket
      ? `${roomPath}/${HMRS_FOLDER_NAMES.structureDrawer}`
      : `${roomPath}/docs_drawer`;
    const summaryDrawer = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      summaryDrawerPath,
    );
    const docsDrawer = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      docsDrawerPath,
    );
    await this.cleanupLegacyArtifacts({
      userId: input.userId,
      drawerToken: docsDrawer.token,
      names: [`document_index_${legacyTokenSlug}.json`],
    });

    await this.repo.writeJsonObject(
      input.userId,
      summaryDrawer.token,
      isTemplateBucket
        ? `模板文件夹摘要_${sourceFolderName}.json`
        : "folder_summary.json",
      {
        ...folderSummary,
        title: `${bucketLabel}-文件夹摘要（${sourceFolderName}）`,
        description: isTemplateBucket
          ? "记录此模板房间内样例文档的标题与摘要，供模板抽取与版式参考。"
          : "该摘要用于快速判断是否需要深入读取此来源文件夹中的原文档。",
        bucketRole,
        bucketLabel,
      },
    );
    await this.repo.writeJsonObject(
      input.userId,
      docsDrawer.token,
      `${bucketLabel}-文档索引_${sourceFolderName}.json`,
      {
        title: `${bucketLabel}-文档索引（${sourceFolderName}）`,
        description: isTemplateBucket
          ? "记录该模板房间内可被引用的样例文档及结构提示。"
          : "该索引用于 Planner/Retriever 进行低成本检索与预算展开决策。",
        generatedAt: new Date().toISOString(),
        sourceFolderToken: input.sourceFolderToken,
        sourceFolderName,
        bucketRole,
        bucketLabel,
        bucketParentPath: input.bucketParentPath ?? null,
        items: docIndexes.map((item) => ({ ...item, bucketRole })),
      },
    );

    if (!isTemplateBucket) {
      const resourcesRoom = await this.repo.ensureFolderPath(
        input.userId,
        input.hmrsRootToken,
        `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`,
      );
      await this.cleanupLegacyArtifacts({
        userId: input.userId,
        drawerToken: resourcesRoom.token,
        names: [`managed_folder_${legacyTokenSlug}.json`],
      });
      await this.repo.writeJsonObject(
        input.userId,
        resourcesRoom.token,
        `纳管记录_${sourceFolderName}.json`,
        {
          title: `纳管记录（${sourceFolderName}）`,
          description: "记录该来源文件夹最近一次纳管执行状态与关联项目房间。",
          sourceFolderToken: input.sourceFolderToken,
          sourceFolderName,
          ingestedAt: new Date().toISOString(),
          docCount: docIndexes.length,
          projectRoom,
          bucketRole,
          bucketLabel,
        },
      );
    }

    return {
      ingestedDocs: docIndexes.length,
      folderToken: input.sourceFolderToken,
      roomPath,
      bucketRole,
    };
  }
}

