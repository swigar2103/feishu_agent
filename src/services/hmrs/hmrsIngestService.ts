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

  async ingestManagedFolder(input: {
    userId: string;
    hmrsRootToken: string;
    sourceFolderToken: string;
    projectName?: string;
  }): Promise<IngestResult> {
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

    await this.repo.writeJsonObject(
      input.userId,
      summaryDrawer.token,
      "folder_summary.json",
      folderSummary,
    );
    await this.repo.writeJsonObject(
      input.userId,
      docsDrawer.token,
      `document_index_${slugify(input.sourceFolderToken)}.json`,
      docIndexes,
    );

    const resourcesRoom = await this.repo.ensureFolderPath(
      input.userId,
      input.hmrsRootToken,
      "resources_wing/imported_docs_room",
    );
    await this.repo.writeJsonObject(
      input.userId,
      resourcesRoom.token,
      `managed_folder_${slugify(input.sourceFolderToken)}.json`,
      {
        sourceFolderToken: input.sourceFolderToken,
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

