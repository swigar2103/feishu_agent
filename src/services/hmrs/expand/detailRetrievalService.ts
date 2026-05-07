import type { CandidateResourceList, DetailedContext } from "../../../schemas/agentContracts.js";
import { DetailedContextSchema } from "../../../schemas/agentContracts.js";
import { TemplateDistillationSchema, type TemplateProfile } from "../../../schemas/templateProfile.js";
import type { UserRequest } from "../../../schemas/index.js";
import { toolGateway } from "../../toolGateway/gateway.js";
import { hasValidUserOAuth } from "../../../storage/userOAuthStore.js";
import { FileIndexRepository } from "../repo/file/fileIndexRepository.js";
import { logger } from "../../../shared/logger.js";

type ExpandedItem = {
  l2Id: string;
  resourceId: string;
  title: string;
  summary: string;
  link: string | undefined;
};

function toFact(sourceId: string, fact: string, evidence?: string) {
  return {
    sourceId,
    fact,
    ...(evidence ? { evidence } : {}),
  };
}

function fromL2ToResourceId(l2Id: string): string {
  return l2Id.replace(/^l2_/, "");
}

type StructureSummaryJson = {
  sectionOrder?: string[];
  reportType?: string;
};

/**
 * 从 L2 条目的 structureSummary JSON 构建 TemplateProfile。
 * 仅在 type === "TemplateStructureIndex" 且 structureSummary 是有效 JSON 时生效。
 */
function buildTemplateProfileFromL2StructureSummary(
  resourceId: string,
  title: string,
  structureSummaryJson: string,
): TemplateProfile | null {
  try {
    const parsed = JSON.parse(structureSummaryJson) as StructureSummaryJson;
    const sectionOrder = parsed.sectionOrder;
    if (!Array.isArray(sectionOrder) || sectionOrder.length === 0) return null;

    return {
      version: 1,
      resourceId,
      sectionOrder,
      fixedLabels: [],
      listPatterns: [],
      styleRules: [`按照「${title}」模板结构，保持章节标题与顺序与原模板一致。`],
      forbiddenPatterns: [],
      slotHints: sectionOrder.map((heading, idx) => ({
        slotId: `slot_${idx + 1}`,
        sectionHeading: heading,
        description: `围绕「${heading}」补齐结构化内容与证据引用`,
      })),
    };
  } catch {
    return null;
  }
}

/**
 * 在展开候选中检测 TemplateStructureIndex 类型，从其 L2 structureSummary JSON
 * 构建 TemplateProfile 并合并到 templateDistillation.profilesByResourceId。
 * 这让 useStrictTemplatePipeline 在用户放入模板文档后自动激活，无需任何显式配置。
 */
async function buildTemplateDistillationFromExpanded(input: {
  expandedL2Ids: string[];
  userId: string;
}): Promise<DetailedContext["templateDistillation"] | undefined> {
  try {
    const indexRepo = new FileIndexRepository();
    const l2Items = await indexRepo.query({
      owner: input.userId,
      ids: input.expandedL2Ids,
      limit: 50,
    });
    const templateL2Items = l2Items.filter((item) => item.type === "TemplateStructureIndex");
    if (templateL2Items.length === 0) return undefined;

    const profilesByResourceId: Record<string, TemplateProfile> = {};
    for (const l2Item of templateL2Items) {
      const resourceId = fromL2ToResourceId(l2Item.id);
      const profile = buildTemplateProfileFromL2StructureSummary(
        resourceId,
        l2Item.title,
        l2Item.structureSummary,
      );
      if (profile) {
        profilesByResourceId[resourceId] = profile;
      }
    }

    if (Object.keys(profilesByResourceId).length === 0) return undefined;

    logger.info("fetchDetailByExpansion: template profiles built from TemplateStructureIndex", {
      userId: input.userId,
      profileCount: Object.keys(profilesByResourceId).length,
      resourceIds: Object.keys(profilesByResourceId),
    });

    return TemplateDistillationSchema.parse({ profilesByResourceId });
  } catch (error) {
    logger.warn("fetchDetailByExpansion: failed to build template distillation", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function fetchDetailByExpansion(input: {
  request: UserRequest;
  expandedL2Ids: string[];
  screened: CandidateResourceList;
}): Promise<DetailedContext> {
  const byId = new Map(input.screened.candidates.map((item) => [item.resourceId, item]));
  const expanded: ExpandedItem[] = input.expandedL2Ids
    .map((l2Id) => {
      const resourceId = fromL2ToResourceId(l2Id);
      const candidate = byId.get(resourceId);
      if (!candidate) return null;
      return {
        l2Id,
        resourceId,
        title: candidate.title,
        summary: candidate.summary,
        link: candidate.link ?? undefined,
      };
    })
    .filter((item): item is ExpandedItem => item !== null);

  const context =
    input.request.userId && hasValidUserOAuth(input.request.userId)
      ? { userId: input.request.userId, preferUserScope: true as const }
      : undefined;

  const facts: DetailedContext["facts"] = [];
  const sourceDetails: DetailedContext["sourceDetails"] = [];

  for (const item of expanded) {
    const rawDocId =
      item.link?.trim() ||
      (item.resourceId.startsWith("ext_doc_")
        ? item.resourceId.replace("ext_doc_", "")
        : item.resourceId);
    const viewed = await toolGateway.viewDocument(rawDocId, context).catch(() => null);
    const content = viewed?.content?.trim();
    if (content) {
      const clipped = content.slice(0, 12_000);
      facts.push(
        toFact(item.resourceId, clipped, "HMRS L3 按需展开正文摘录"),
      );
      sourceDetails.push({
        resourceId: item.resourceId,
        detail: content,
      });
      continue;
    }
    facts.push(
      toFact(item.resourceId, item.summary, "HMRS L3 展开失败，回退摘要"),
    );
    sourceDetails.push({
      resourceId: item.resourceId,
      detail: `${item.title}\n${item.summary}`,
    });
  }

  // 检测 TemplateStructureIndex 候选，自动构建 TemplateProfile 注入 templateDistillation
  const templateDistillation = input.request.userId
    ? await buildTemplateDistillationFromExpanded({
        expandedL2Ids: input.expandedL2Ids,
        userId: input.request.userId,
      })
    : undefined;

  return DetailedContextSchema.parse({
    facts,
    sourceDetails,
    ...(templateDistillation ? { templateDistillation } : {}),
  });
}
