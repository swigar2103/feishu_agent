import { env } from "../../config/env.js";
import { logger } from "../../shared/logger.js";
import { HmrsIngestService } from "./hmrsIngestService.js";
import { UserDatabaseBootstrapService } from "./userDatabaseBootstrapService.js";
import { HmrsRepository } from "./hmrsRepository.js";
import type { HmrsRefreshStatus } from "./model/memPalaceTree.js";
import { createHash } from "node:crypto";

function readManagedFolderTokens(): string[] {
  return env.HMRS_MANAGED_FOLDER_TOKENS
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function discoverManagedFolderTokens(input: {
  userId: string;
  hmrsRootName: string;
  repo: HmrsRepository;
}): Promise<string[]> {
  const root = await input.repo.getRootFolderMeta(input.userId);
  const children = await input.repo.listChildFolders(input.userId, root.token);
  const candidates = children.filter((item) => item.name !== input.hmrsRootName).slice(0, 30);
  const discovered: string[] = [];
  for (const folder of candidates) {
    const docs = await input.repo.listDocsInFolder(input.userId, folder.token).catch(() => []);
    if (docs.length <= 0) continue;
    discovered.push(folder.token);
    if (discovered.length >= 6) break;
  }
  return discovered;
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
    const previousStatus = await this.repo.readJsonObjectByName<HmrsRefreshStatus>(
      input.userId,
      bootstrap.systemFolderToken,
      "refresh_status.json",
    );
    const configuredTokens = readManagedFolderTokens();
    const managedFolderTokens =
      configuredTokens.length > 0
        ? configuredTokens
        : await discoverManagedFolderTokens({
            userId: input.userId,
            hmrsRootName: bootstrap.rootFolderName,
            repo: this.repo,
          });
    let ingestedDocCount = 0;
    let firstError: string | undefined;
    const folderSignatures: Record<string, string> = {};

    for (const folderToken of managedFolderTokens) {
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
          projectName: "managed_folder_ingest",
        });
        ingestedDocCount += result.ingestedDocs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!firstError) firstError = message;
        logger.warn("hmrs refresh ingest skipped for folder", {
          userId: input.userId,
          folderToken,
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

