import { toolGateway } from "../toolGateway/gateway.js";
import { HmrsRepository } from "./hmrsRepository.js";
import { buildDocumentIndexes, buildFolderSummary } from "./summaryBuilder.js";

export type IngestResult = {
  ingestedDocs: number;
  folderToken: string;
  roomPath: string;
};

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "default_project";
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
  }): Promise<IngestResult> {
    const folderMeta = await this.repo.getFolderMeta(input.userId, input.sourceFolderToken).catch(() => null);
    const sourceFolderName = this.readableShortName(folderMeta?.name ?? input.sourceFolderToken);
    const docs = await this.repo.listDocsInFolder(input.userId, input.sourceFolderToken);
    const viewed = [];
    for (const doc of docs.slice(0, 30)) {
      const detail = await toolGateway.viewDocument(doc.token, {
        userId: input.userId,
        preferUserScope: true,
      }).catch(() => null);
      viewed.push({
        id: doc.token,
        title: doc.title,
        summary: detail?.summary ?? detail?.content?.slice(0, 240),
        content: detail?.content,
        url: detail?.url,
        source: detail?.source,
      });
    }

    const folderSummary = buildFolderSummary({
      folderToken: input.sourceFolderToken,
      docs: viewed,
    });
    const docIndexes = buildDocumentIndexes(viewed);
    const legacyTokenSlug = slugify(input.sourceFolderToken);
    const projectRoom = `${slugify(input.projectName ?? "managed_project")}_room`;
    const roomPath = `projects_wing/${projectRoom}`;
    const summaryDrawer = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      `${roomPath}/summary_drawer`,
    );
    const docsDrawer = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      `${roomPath}/docs_drawer`,
    );
    await this.cleanupLegacyArtifacts({
      userId: input.userId,
      drawerToken: docsDrawer.token,
      names: [`document_index_${legacyTokenSlug}.json`],
    });

    await this.repo.writeJsonObject(
      input.userId,
      summaryDrawer.token,
      "folder_summary.json",
      {
        ...folderSummary,
        title: `文件夹摘要（${sourceFolderName}）`,
        description: "该摘要用于快速判断是否需要深入读取此来源文件夹中的原文档。",
      },
    );
    await this.repo.writeJsonObject(
      input.userId,
      docsDrawer.token,
      `文档索引_${sourceFolderName}.json`,
      {
        title: `文档索引（${sourceFolderName}）`,
        description: "该索引用于 Planner/Retriever 进行低成本检索与预算展开决策。",
        generatedAt: new Date().toISOString(),
        sourceFolderToken: input.sourceFolderToken,
        sourceFolderName,
        items: docIndexes,
      },
    );

    const resourcesRoom = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      "resources_wing/imported_docs_room",
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
      },
    );

    return {
      ingestedDocs: docIndexes.length,
      folderToken: input.sourceFolderToken,
      roomPath,
    };
  }
}

