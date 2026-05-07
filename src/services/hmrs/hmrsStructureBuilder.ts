import type { HmrsWing } from "./model/memPalaceTree.js";

export const HMRS_FOLDER_NAMES = {
  system: "_系统配置",
  peopleWing: "个人画像库",
  projectsWing: "项目知识库",
  templatesWing: "模板知识库",
  resourcesWing: "资源纳管库",
  conversationsWing: "会话沉淀库",
  selfRoom: "我的偏好房间",
  styleDrawer: "风格抽屉",
  writingThoughtDrawer: "写作思路抽屉",
  exemplarDrawer: "高质量样例抽屉",
  profileDrawer: "用户画像抽屉",
  weeklyReportRoom: "周报模板房间",
  meetingSummaryRoom: "会议纪要模板房间",
  proposalRoom: "方案模板房间",
  structureDrawer: "结构抽屉",
  visualSlotsDrawer: "可视化槽位抽屉",
  examplesDrawer: "示例抽屉",
  importedDocsRoom: "已纳管文档房间",
  importedFilesRoom: "已纳管文件房间",
  importedChatsRoom: "已纳管会话房间",
  importedSlidesRoom: "已纳管幻灯片房间",
} as const;

export function buildUserHmrsRootName(input: { userId: string; nickname?: string }): string {
  const safeNick = (input.nickname ?? "")
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  if (safeNick) return `${safeNick}_${input.userId}_个人数据库`;
  return `${input.userId}_个人数据库`;
}

export function buildBaseWingNames(): HmrsWing[] {
  return [
    "people_wing",
    "projects_wing",
    "templates_wing",
    "resources_wing",
    "conversations_wing",
  ];
}

export function buildRequiredFolders(): string[] {
  return [
    HMRS_FOLDER_NAMES.system,
    `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.styleDrawer}`,
    `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.writingThoughtDrawer}`,
    `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.exemplarDrawer}`,
    `${HMRS_FOLDER_NAMES.peopleWing}/${HMRS_FOLDER_NAMES.selfRoom}/${HMRS_FOLDER_NAMES.profileDrawer}`,
    HMRS_FOLDER_NAMES.projectsWing,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.weeklyReportRoom}/${HMRS_FOLDER_NAMES.structureDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.weeklyReportRoom}/${HMRS_FOLDER_NAMES.visualSlotsDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.weeklyReportRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.meetingSummaryRoom}/${HMRS_FOLDER_NAMES.structureDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.meetingSummaryRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.proposalRoom}/${HMRS_FOLDER_NAMES.structureDrawer}`,
    `${HMRS_FOLDER_NAMES.templatesWing}/${HMRS_FOLDER_NAMES.proposalRoom}/${HMRS_FOLDER_NAMES.examplesDrawer}`,
    `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedDocsRoom}`,
    `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedFilesRoom}`,
    `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedChatsRoom}`,
    `${HMRS_FOLDER_NAMES.resourcesWing}/${HMRS_FOLDER_NAMES.importedSlidesRoom}`,
    HMRS_FOLDER_NAMES.conversationsWing,
  ];
}
