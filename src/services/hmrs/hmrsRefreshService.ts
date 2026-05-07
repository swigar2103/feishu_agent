import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { HmrsIngestService, type IngestBucketRole } from "./hmrsIngestService.js";
import { UserDatabaseBootstrapService } from "./userDatabaseBootstrapService.js";
import { HmrsRepository } from "./hmrsRepository.js";
import type { HmrsRefreshStatus } from "./model/memPalaceTree.js";
import { buildRequiredFolders, HMRS_FOLDER_NAMES } from "./hmrsStructureBuilder.js";
import { getStyleDistillationService } from "./styleDistillationService.js";
import { createHash } from "node:crypto";

type DiscoveredBucketSource = {
  folderToken: string;
  bucketRole: IngestBucketRole;
  bucketLabel: string;
  parentPath: string;
};

function readManagedFolderTokens(): string[] {
  return env.HMRS_MANAGED_FOLDER_TOKENS
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 从个人数据库内部的纳管房间发现来源文件夹，作为唯一索引面。
 * 不再扫描用户云盘根目录中的兄弟文件夹，避免污染私域。
 */
async function discoverHmrsBucketSources(input: {
  userId: string;
  rootFolderToken: string;
  repo: HmrsRepository;
}): Promise<DiscoveredBucketSource[]> {
  const buckets: Array<{ path: string; role: IngestBucketRole; label: string }> = [
    {
      path: `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`,
      role: "work_material",
      label: HMRS_FOLDER_NAMES.importedDocsRoom,
    },
    {
      path: `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.weeklyReportRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
      role: "template_example",
      label: `${HMRS_FOLDER_NAMES.weeklyReportRoom}-${HMRS_FOLDER_NAMES.examplesDrawer}`,
    },
    {
      path: `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.meetingSummaryRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
      role: "template_example",
      label: `${HMRS_FOLDER_NAMES.meetingSummaryRoom}-${HMRS_FOLDER_NAMES.examplesDrawer}`,
    },
    {
      path: `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.proposalRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
      role: "template_example",
      label: `${HMRS_FOLDER_NAMES.proposalRoom}-${HMRS_FOLDER_NAMES.examplesDrawer}`,
    },
  ];
  const sources: DiscoveredBucketSource[] = [];
  for (const bucket of buckets) {
    try {
      const ensured = await input.repo.ensureFolderPath(input.userId, input.rootFolderToken, bucket.path);
      const docs = await input.repo.listDocsInFolder(input.userId, ensured.token).catch(() => []);
      if (docs.length <= 0) continue;
      sources.push({
        folderToken: ensured.token,
        bucketRole: bucket.role,
        bucketLabel: bucket.label,
        parentPath: bucket.path,
      });
    } catch (error) {
      logger.warn("hmrs bucket discover failed", {
        userId: input.userId,
        path: bucket.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

