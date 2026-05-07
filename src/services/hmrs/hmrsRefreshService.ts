import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { HmrsIngestService, type IngestBucketRole } from "./hmrsIngestService.js";
import { UserDatabaseBootstrapService } from "./userDatabaseBootstrapService.js";
import { HmrsRepository } from "./hmrsRepository.js";
import type { HmrsRefreshStatus } from "./model/memPalaceTree.js";
import { buildRequiredFolders, HMRS_FOLDER_NAMES } from "./hmrsStructureBuilder.js";
import { getStyleDistillationService } from "./styleDistillationService.js";
import { FileCatalogRepository } from "./repo/file/fileCatalogRepository.js";
import { FileIndexRepository } from "./repo/file/fileIndexRepository.js";
import type { L1CatalogObject, L2IndexObject } from "./model/layerSchemas.js";
import { createHash } from "node:crypto";

type DiscoveredBucketSource = {
  folderToken: string;
  bucketRole: IngestBucketRole;
  bucketLabel: string;
  parentPath: string;
};

type TemplateDocIndexItem = {
  docToken?: string;
  title?: string;
  structureSummary?: string;
  summary?: string;
  sourceUrl?: string;
};

type TemplateIndexFile = {
  items?: TemplateDocIndexItem[];
  bucketRole?: string;
  bucketParentPath?: string;
};

/**
 * 从云盘 templates_wing 每个 room 的 structureDrawer 读取 JSON artifacts，
 * 将 TemplateStructureIndex 条目回写到本地 hmrs-catalog.json / hmrs-index.json。
 *
 * 这消除了 Gap 1（ingest 写到云盘但本地 catalog 从未读回）和
 * Gap 3（templateSkillStore 读 catalog 但 templates_wing 条目为空）。
 */
async function syncTemplateArtifactsToLocalCatalog(input: {
  userId: string;
  rootFolderToken: string;
  repo: HmrsRepository;
}): Promise<void> {
  const catalogRepo = new FileCatalogRepository();
  const indexRepo = new FileIndexRepository();
  const now = new Date().toISOString();

  try {
    const templatesWingFolder = await input.repo.ensureFolderPath(
      input.userId,
      input.rootFolderToken,
      HMRS_FOLDER_NAMES.templatesWing,
    );
    const roomFolders = await input.repo.listChildFolders(input.userId, templatesWingFolder.token);

    const l1Items: L1CatalogObject[] = [];
    const l2Items: L2IndexObject[] = [];

    for (const room of roomFolders) {
      const structurePath = `${HMRS_FOLDER_NAMES.templatesWing}/${room.name}/${HMRS_FOLDER_NAMES.structureDrawer}`;
      try {
        const structureDrawer = await input.repo.ensureFolderPath(
          input.userId,
          input.rootFolderToken,
          structurePath,
        );
        const folderItems = await input.repo.listFolderItems(input.userId, structureDrawer.token);
        const jsonFiles = folderItems.filter(
          (item) => !item.type.toLowerCase().includes("folder") && item.name.endsWith(".json"),
        );

        for (const jsonFile of jsonFiles) {
          try {
            const parsed = await input.repo.readJsonObjectByName<TemplateIndexFile>(
              input.userId,
              structureDrawer.token,
              jsonFile.name,
            );
            if (!parsed?.items || parsed.items.length === 0) continue;

            for (const item of parsed.items) {
              if (!item.docToken || !item.title) continue;
              if (!item.structureSummary) continue;

              const l1Id = `l1_tmpl_${item.docToken}`;
              const l2Id = `l2_tmpl_${item.docToken}`;

              l1Items.push({
                id: l1Id,
                type: "TemplateStructureIndex",
                layer: "L1",
                wingId: "templates_wing",
                roomId: room.name,
                drawerId: "structure_drawer",
                owner: input.userId,
                projectTag: "模板",
                timeRange: { end: now },
                keywords: [item.title, room.name],
                qualityScore: 0.85,
                sourceRef: {
                  sourceType: "doc",
                  docToken: item.docToken,
                  url: item.sourceUrl,
                },
                title: item.title,
                summary: item.summary ?? item.title,
              });

              l2Items.push({
                id: l2Id,
                type: "TemplateStructureIndex",
                layer: "L2",
                wingId: "templates_wing",
                roomId: room.name,
                drawerId: "structure_drawer",
                owner: input.userId,
                projectTag: "模板",
                timeRange: { end: now },
                keywords: [item.title, room.name],
                qualityScore: 0.85,
                sourceRef: {
                  sourceType: "doc",
                  docToken: item.docToken,
                  url: item.sourceUrl,
                },
                parentId: l1Id,
                title: item.title,
                structureSummary: item.structureSummary,
              });
            }
          } catch (fileError) {
            logger.warn("syncTemplateArtifacts: failed to read json file", {
              userId: input.userId,
              roomName: room.name,
              fileName: jsonFile.name,
              error: fileError instanceof Error ? fileError.message : String(fileError),
            });
          }
        }
      } catch (roomError) {
        logger.warn("syncTemplateArtifacts: failed to scan room structureDrawer", {
          userId: input.userId,
          roomName: room.name,
          error: roomError instanceof Error ? roomError.message : String(roomError),
        });
      }
    }

    if (l1Items.length > 0) {
      await catalogRepo.upsert(l1Items);
      await indexRepo.upsert(l2Items);
      logger.info("syncTemplateArtifacts: synced template entries to local catalog", {
        userId: input.userId,
        l1Count: l1Items.length,
        l2Count: l2Items.length,
      });
    }
  } catch (error) {
    logger.warn("syncTemplateArtifacts: failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readManagedFolderTokens(): string[] {
  return env.HMRS_MANAGED_FOLDER_TOKENS
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 从个人数据库内部的纳管房间发现来源文件夹，作为唯一索引面。
 *
 * 策略：
 * 1. 固定工作资料桶（资源纳管库/已纳管文档房间）。
 * 2. 模板桶：动态枚举 "模板知识库" 下所有 room 子目录，对每个 room 扫描 "示例抽屉"；
 *    这样新增房间（日报、业务周报等）无需修改此函数，也兼容用户自建的额外模板房间。
 * 3. bucketParentPath 传 **room 路径**（不含 "/示例抽屉"），确保 ingestManagedFolder
 *    把 structureDrawer 写到正确的 "模板知识库/{room}/结构抽屉" 而非嵌套到 "示例抽屉" 下。
 */
async function discoverHmrsBucketSources(input: {
  userId: string;
  rootFolderToken: string;
  repo: HmrsRepository;
}): Promise<DiscoveredBucketSource[]> {
  const sources: DiscoveredBucketSource[] = [];

  // 1. 固定工作资料桶
  const workPath = `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`;
  try {
    const ensured = await input.repo.ensureFolderPath(input.userId, input.rootFolderToken, workPath);
    const docs = await input.repo.listDocsInFolder(input.userId, ensured.token).catch(() => []);
    if (docs.length > 0) {
      sources.push({
        folderToken: ensured.token,
        bucketRole: "work_material",
        bucketLabel: HMRS_FOLDER_NAMES.importedDocsRoom,
        parentPath: workPath,
      });
    }
  } catch (error) {
    logger.warn("hmrs work_material bucket discover failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. 模板桶：动态发现 "模板知识库" 下所有 room
  try {
    const templatesWingFolder = await input.repo.ensureFolderPath(
      input.userId,
      input.rootFolderToken,
      HMRS_FOLDER_NAMES.templatesWing,
    );
    const roomFolders = await input.repo.listChildFolders(input.userId, templatesWingFolder.token);

    for (const room of roomFolders) {
      const roomPath = `${HMRS_FOLDER_NAMES.templatesWing}/${room.name}`;
      const examplesPath = `${roomPath}/${HMRS_FOLDER_NAMES.examplesDrawer}`;
      try {
        const examplesFolder = await input.repo.ensureFolderPath(
          input.userId,
          input.rootFolderToken,
          examplesPath,
        );
        const docs = await input.repo.listDocsInFolder(input.userId, examplesFolder.token).catch(() => []);
        if (docs.length <= 0) continue;
        sources.push({
          folderToken: examplesFolder.token,
          bucketRole: "template_example",
          bucketLabel: `${room.name}-${HMRS_FOLDER_NAMES.examplesDrawer}`,
          // parentPath = room 路径（不含 /示例抽屉），避免 ingestManagedFolder 把
          // structureDrawer 写到错误的嵌套路径 "示例抽屉/结构抽屉"
          parentPath: roomPath,
        });
      } catch (error) {
        logger.warn("hmrs template room bucket discover failed", {
          userId: input.userId,
          roomName: room.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    logger.warn("hmrs templates wing discover failed", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return sources;
}

export class HmrsRefreshService {
  private static readonly lastRefreshAtByUser = new Map<string, number>();
  private static readonly lastResultByUser = new Map<
    string,
    { rootFolderToken: string; managedFolderCount: number; ingestedDocCount: number }
  >();
  private static readonly lastStatusByUser = new Map<string, HmrsRefreshStatus>();
  private readonly bootstrapService = new UserDatabaseBootstrapService();
  private readonly ingestService = new HmrsIngestService();
  private readonly repo = new HmrsRepository();

  private buildFolderSignature(
    docs: Array<{ token: string; title: string; modifiedTime?: number }>,
  ): string {
    const normalized = docs
      .map((doc) => `${doc.token}:${doc.modifiedTime ?? 0}`)
      .sort();
    return createHash("sha1").update(normalized.join("|")).digest("hex");
  }

  async refreshForUser(input: {
    userId: string;
    nickname?: string;
  }): Promise<{
    rootFolderToken: string;
    managedFolderCount: number;
    ingestedDocCount: number;
  }> {
    const nowMs = Date.now();
    const minIntervalMs = env.HMRS_REFRESH_MIN_INTERVAL_SECONDS * 1000;
    const last = HmrsRefreshService.lastRefreshAtByUser.get(input.userId) ?? 0;
    if (nowMs - last < minIntervalMs) {
      const cached = HmrsRefreshService.lastResultByUser.get(input.userId);
      if (cached) return cached;
      const boot = await this.bootstrapService.bootstrap({
        userId: input.userId,
        nickname: input.nickname,
      });
      return {
        rootFolderToken: boot.rootFolderToken,
        managedFolderCount: 0,
        ingestedDocCount: 0,
      };
    }
    const bootstrap = await this.bootstrapService.bootstrap({
      userId: input.userId,
      nickname: input.nickname,
    });
    const layout = await this.repo.ensureRequiredFolderLayout(
      input.userId,
      bootstrap.rootFolderToken,
      buildRequiredFolders(),
    );
    if (layout.repairedPaths.length > 0) {
      logger.info("hmrs layout repaired", {
        userId: input.userId,
        repairedCount: layout.repairedPaths.length,
      });
    }
    const previousStatus = await this.repo.readJsonObjectByName<HmrsRefreshStatus>(
      input.userId,
      bootstrap.systemFolderToken,
      "refresh_status.json",
    );
    const configuredTokens = readManagedFolderTokens();
    const bucketSources =
      configuredTokens.length > 0
        ? configuredTokens.map((folderToken) => ({
            folderToken,
            bucketRole: "work_material" as IngestBucketRole,
            bucketLabel: "configured",
            parentPath: "(env-configured)",
          }))
        : await discoverHmrsBucketSources({
            userId: input.userId,
            rootFolderToken: bootstrap.rootFolderToken,
            repo: this.repo,
          });
    const managedFolderTokens = bucketSources.map((source) => source.folderToken);
    let ingestedDocCount = 0;
    let firstError: string | undefined;
    const folderSignatures: Record<string, string> = {};

    for (const source of bucketSources) {
      const folderToken = source.folderToken;
      try {
        const docs = await this.repo.listDocsInFolder(input.userId, folderToken);
        const nextSignature = this.buildFolderSignature(docs);
        folderSignatures[folderToken] = nextSignature;
        const prevSignature = previousStatus?.folderSignatures?.[folderToken];
        if (prevSignature && prevSignature === nextSignature) {
          continue;
        }
        const result = await this.ingestService.ingestManagedFolder({
          userId: input.userId,
          hmrsRootToken: bootstrap.rootFolderToken,
          sourceFolderToken: folderToken,
          projectName: source.bucketLabel || "managed_folder_ingest",
          bucketRole: source.bucketRole,
          bucketParentPath: source.parentPath,
        });
        ingestedDocCount += result.ingestedDocs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!firstError) firstError = message;
        logger.warn("hmrs refresh ingest skipped for folder", {
          userId: input.userId,
          folderToken,
          bucketRole: source.bucketRole,
          error: message,
        });
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    const status: HmrsRefreshStatus = {
      userId: input.userId,
      managedFolderTokens,
      folderSignatures,
      lastRefreshAt: nowIso,
      ...(ingestedDocCount > 0 ? { lastIngestAt: nowIso } : {}),
      ...(firstError ? { lastError: firstError } : {}),
    };
    await this.repo
      .writeJsonObject(input.userId, bootstrap.systemFolderToken, "refresh_status.json", status)
      .catch((error) => {
        logger.warn("hmrs refresh status write failed", {
          userId: input.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    HmrsRefreshService.lastStatusByUser.set(input.userId, status);
    HmrsRefreshService.lastRefreshAtByUser.set(input.userId, nowMs);
    const result = {
      rootFolderToken: bootstrap.rootFolderToken,
      managedFolderCount: managedFolderTokens.length,
      ingestedDocCount,
    };
    HmrsRefreshService.lastResultByUser.set(input.userId, result);

    // 将云盘 template structureDrawer 里的 JSON 回读到本地 catalog（不阻塞主链路）
    void syncTemplateArtifactsToLocalCatalog({
      userId: input.userId,
      rootFolderToken: bootstrap.rootFolderToken,
      repo: this.repo,
    }).catch((error) => {
      logger.warn("syncTemplateArtifacts failed", {
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    /**
     * 异步触发写作风格蒸馏：不阻塞 refresh 主链路。
     * 仅当本轮有新增 ingest 时启动，避免无意义重算。
     */
    if (ingestedDocCount > 0) {
      void getStyleDistillationService()
        .distillAndPersist({
          userId: input.userId,
          hmrsRootToken: bootstrap.rootFolderToken,
          trigger: "refresh",
        })
        .catch((error) => {
          logger.warn("style distill after refresh failed", {
            userId: input.userId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return result;
  }

  async getRefreshStatus(input: {
    userId: string;
    nickname?: string;
  }): Promise<{
    rootFolderToken: string;
    status: HmrsRefreshStatus;
  }> {
    const cachedStatus = HmrsRefreshService.lastStatusByUser.get(input.userId);
    if (cachedStatus) {
      const cachedResult = HmrsRefreshService.lastResultByUser.get(input.userId);
      return {
        rootFolderToken: cachedResult?.rootFolderToken ?? "",
        status: cachedStatus,
      };
    }
    const boot = await this.bootstrapService.bootstrap({
      userId: input.userId,
      nickname: input.nickname,
    });
    const persisted = await this.repo.readJsonObjectByName<HmrsRefreshStatus>(
      input.userId,
      boot.systemFolderToken,
      "refresh_status.json",
    );
    if (persisted) {
      HmrsRefreshService.lastStatusByUser.set(input.userId, persisted);
      return {
        rootFolderToken: boot.rootFolderToken,
        status: persisted,
      };
    }
    return {
      rootFolderToken: boot.rootFolderToken,
      status: {
        userId: input.userId,
        managedFolderTokens: [],
      },
    };
  }
}

