import { env } from "../../config/env.js";
import { splitOAuthScopes } from "../../integrations/feishu/userOAuthAuthorizeFlow.js";
import type {
  HmrsManifest,
  HmrsPermissions,
  HmrsRecallBudget,
  HmrsRefreshStatus,
} from "./model/memPalaceTree.js";
import { buildBaseWingNames, buildRequiredFolders, buildUserHmrsRootName } from "./hmrsStructureBuilder.js";
import { HmrsRepository } from "./hmrsRepository.js";

export type BootstrapResult = {
  rootFolderToken: string;
  rootFolderName: string;
  systemFolderToken: string;
  createdAt: string;
};

export class UserDatabaseBootstrapService {
  constructor(private readonly repo: HmrsRepository = new HmrsRepository()) {}

  async bootstrap(input: { userId: string; nickname?: string }): Promise<BootstrapResult> {
    const now = new Date().toISOString();
    const rootMeta = await this.repo.getRootFolderMeta(input.userId);
    const rootName = buildUserHmrsRootName({ userId: input.userId, nickname: input.nickname });
    const existed = await this.repo.findChildFolderByName(input.userId, rootMeta.token, rootName);
    const rootFolderToken = existed
      ? existed.token
      : (await this.repo.createFolder(input.userId, rootMeta.token, rootName)).token;

    for (const requiredPath of buildRequiredFolders()) {
      await this.repo.ensureFolderPath(input.userId, rootFolderToken, requiredPath);
    }
    const systemFolder = await this.repo.ensureFolderPath(input.userId, rootFolderToken, "_system");

    const manifest: HmrsManifest = {
      version: "hmrs_v1",
      userId: input.userId,
      nickname: input.nickname,
      rootFolderName: rootName,
      rootFolderToken,
      createdAt: now,
      updatedAt: now,
      sourceOfTruth: "feishu_user_space",
      wings: buildBaseWingNames(),
    };
    const refreshStatus: HmrsRefreshStatus = {
      userId: input.userId,
      lastBootstrapAt: now,
      managedFolderTokens: [],
    };
    const recallBudget: HmrsRecallBudget = {
      maxRoomsPerRound: 6,
      maxDocsPerRound: 8,
      maxSnippetsPerRound: 24,
      maxCharsPerRound: 30_000,
    };
    const permissions: HmrsPermissions = {
      identityMode: env.FEISHU_MCP_IDENTITY,
      scopes: splitOAuthScopes(env.FEISHU_USER_OAUTH_SCOPES),
      writable: true,
    };

    await this.repo.writeSystemObjects({
      userId: input.userId,
      systemFolderToken: systemFolder.token,
      manifest,
      refreshStatus,
      recallBudget,
      permissions,
    });

    const styleFolder = await this.repo.ensureFolderPath(
      input.userId,
      rootFolderToken,
      "people_wing/self_room/style_drawer",
    );
    const thoughtFolder = await this.repo.ensureFolderPath(
      input.userId,
      rootFolderToken,
      "people_wing/self_room/writing_thought_drawer",
    );
    await this.repo.writeMarkdownObject(
      input.userId,
      styleFolder.token,
      "style_identity.md",
      [
        `# Style Identity (${input.userId})`,
        "",
        "- 语气：专业、清晰、行动导向",
        "- 结构：先结论后证据",
        "- 输出偏好：模板化初稿 + 可编辑槽位",
      ].join("\n"),
    );
    await this.repo.writeMarkdownObject(
      input.userId,
      thoughtFolder.token,
      "writing_thought.md",
      [
        `# Writing Thought (${input.userId})`,
        "",
        "1. 先抽取事实，再组织结构。",
        "2. 明确行动项、负责人与时间线。",
        "3. 对齐模板结构与质量检查项。",
      ].join("\n"),
    );

    return {
      rootFolderToken,
      rootFolderName: rootName,
      systemFolderToken: systemFolder.token,
      createdAt: now,
    };
  }
}

