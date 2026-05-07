import { env } from "../../config/env.js";
import { splitOAuthScopes } from "../../integrations/feishu/userOAuthAuthorizeFlow.js";
import type {
  HmrsManifest,
  HmrsPermissions,
  HmrsRecallBudget,
  HmrsRefreshStatus,
} from "./model/memPalaceTree.js";
import {
  buildBaseWingNames,
  buildRequiredFolders,
  buildUserHmrsRootName,
  HMRS_FOLDER_NAMES,
} from "./hmrsStructureBuilder.js";
import { HmrsRepository } from "./hmrsRepository.js";

export type BootstrapResult = {
  rootFolderToken: string;
  rootFolderName: string;
  systemFolderToken: string;
  createdAt: string;
};

export class UserDatabaseBootstrapService {
  constructor(private readonly repo: HmrsRepository = new HmrsRepository()) {}

  private async resolveExistingRootFolder(input: {
    userId: string;
    rootToken: string;
    exactName: string;
  }): Promise<{ token: string; name: string } | null> {
    const exact = await this.repo.findChildFolderByName(input.userId, input.rootToken, input.exactName);
    if (exact) return { token: exact.token, name: exact.name };
    const children = await this.repo.listChildFolders(input.userId, input.rootToken);
    const oldSuffix = `_${input.userId}_mempalace`;
    const newSuffix = `_${input.userId}_个人数据库`;
    const loose = children.find(
      (item) =>
        item.name.endsWith(oldSuffix) ||
        item.name === `${input.userId}_mempalace` ||
        item.name.endsWith(newSuffix) ||
        item.name === `${input.userId}_个人数据库`,
    );
    if (!loose) return null;
    return { token: loose.token, name: loose.name };
  }

  private async writeFolderGuideDocs(input: { userId: string; rootFolderToken: string }): Promise<void> {
    const guides: Array<{ path: string; fileName: string; content: string }> = [
      {
        path: "",
        fileName: "README_个人数据库说明.md",
        content: [
          "# 个人数据库（HMRS）使用说明",
          "",
          "这是办公 Agent 为你维护的长期记忆目录。",
          "上传文件时，请按用途选择对应的子文件夹，**不要再让 Agent 去你的私人云盘根目录扫描**：",
          "",
          "## 你需要主动上传的目录",
          `- \`${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}/\`：过往工作资料、项目素材、案例文档（作为事实证据库）`,
          `- \`${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.weeklyReportRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}/\`：周报模板样例`,
          `- \`${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.meetingSummaryRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}/\`：会议纪要模板样例`,
          `- \`${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.proposalRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}/\`：方案/汇报模板样例`,
          "",
          "## 由系统自动维护、请不要手工编辑的目录",
          `- \`${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.styleDrawer}/\`：写作风格画像（由 LLM 蒸馏，越用越准）`,
          `- \`${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.writingThoughtDrawer}/\`：写作思路画像（同上）`,
          `- \`${HMRS_FOLDER_NAMES.projectsWing}/\`：按项目沉淀的摘要/索引（由系统纳管时生成）`,
          `- \`${HMRS_FOLDER_NAMES.system}/\`：manifest/状态/预算/权限`,
          "",
          "刷新规则：你上传到上面「主动上传目录」后，下一次刷新会自动把它纳管成可被检索/写作引用的索引；不再扫描你云盘根目录的兄弟文件夹。",
        ].join("\n"),
      },
      {
        path: HMRS_FOLDER_NAMES.system,
        fileName: "说明_系统文件夹.md",
        content: "# 系统文件夹说明\n\n该目录保存 manifest、刷新状态、预算与权限元数据，请勿手工删除。",
      },
      {
        path: HMRS_FOLDER_NAMES.peopleWing,
        fileName: "说明_个人偏好库.md",
        content: "# 个人偏好库\n\n保存你的风格偏好、写作思路、常用表达和高质量样例。",
      },
      {
        path: HMRS_FOLDER_NAMES.projectsWing,
        fileName: "说明_项目知识库.md",
        content: "# 项目知识库\n\n保存项目摘要、文档索引、行动项与风险沉淀。",
      },
      {
        path: HMRS_FOLDER_NAMES.templatesWing,
        fileName: "说明_模板知识库.md",
        content: "# 模板知识库\n\n保存周报/会议纪要/汇报模板结构、示例和图表槽位。",
      },
      {
        path: `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`,
        fileName: "说明_纳管文档索引.md",
        content: [
          "# 纳管文档索引说明",
          "",
          "本目录记录外部资料纳管结果，每个来源文件夹通常会生成：",
          "",
          "- 文件夹摘要（中文标题）",
          "- 文档索引（中文标题）",
          "- 纳管记录（含来源 token、纳管时间、数量）",
        ].join("\n"),
      },
      {
        path: HMRS_FOLDER_NAMES.conversationsWing,
        fileName: "说明_会话沉淀库.md",
        content: "# 会话沉淀库\n\n保存对话摘要、任务上下文与可复用经验。",
      },
    ];
    for (const guide of guides) {
      const folderToken = guide.path
        ? (await this.repo.ensureFolderPath(input.userId, input.rootFolderToken, guide.path)).token
        : input.rootFolderToken;
      await this.repo.writeMarkdownObject(input.userId, folderToken, guide.fileName, guide.content);
    }
  }

  async bootstrap(input: { userId: string; nickname?: string }): Promise<BootstrapResult> {
    const now = new Date().toISOString();
    const rootMeta = await this.repo.getRootFolderMeta(input.userId);
    const rootName = buildUserHmrsRootName({ userId: input.userId, nickname: input.nickname });
    const existed = await this.resolveExistingRootFolder({
      userId: input.userId,
      rootToken: rootMeta.token,
      exactName: rootName,
    });
    const rootFolderToken = existed
      ? existed.token
      : (await this.repo.createFolder(input.userId, rootMeta.token, rootName)).token;

    await this.repo.ensureRequiredFolderLayout(
      input.userId,
      rootFolderToken,
      buildRequiredFolders(),
    );
    const systemFolder = await this.repo.ensureFolderPath(
      input.userId,
      rootFolderToken,
      HMRS_FOLDER_NAMES.system,
    );

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
      `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.styleDrawer}`,
    );
    const thoughtFolder = await this.repo.ensureFolderPath(
      input.userId,
      rootFolderToken,
      `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.writingThoughtDrawer}`,
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
    await this.writeFolderGuideDocs({
      userId: input.userId,
      rootFolderToken,
    });

    return {
      rootFolderToken,
      rootFolderName: existed?.name ?? rootName,
      systemFolderToken: systemFolder.token,
      createdAt: now,
    };
  }
}

