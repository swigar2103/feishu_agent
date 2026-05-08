import type { CandidateResourceList, DetailedContext } from "../../../schemas/agentContracts.js";
import { DetailedContextSchema } from "../../../schemas/agentContracts.js";
import { TemplateDistillationSchema, type TemplateProfile } from "../../../schemas/templateProfile.js";
import type { UserRequest } from "../../../schemas/index.js";
import { toolGateway } from "../../toolGateway/gateway.js";
import { hasValidUserOAuth } from "../../../storage/userOAuthStore.js";
import { FileIndexRepository } from "../repo/file/fileIndexRepository.js";
import { HmrsRepository } from "../hmrsRepository.js";
import { logger } from "../../../shared/logger.js";
import { env } from "../../../config/env.js";

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

/**
 * 从选定的飞书子文件夹中逐文件读取真实内容（MemPalace Step 3）。
 * 仅在 targetFolderTokens 非空时执行；每个文件夹列出文档后逐一调 viewDocument（UAT + openapi 优先）。
 */
async function fetchDocsFromFolders(input: {
  userId: string;
  targetFolderTokens: string[];
  maxDocsPerFolder?: number;
  maxCharsPerDoc?: number;
}): Promise<Array<{ token: string; title: string; content: string; url?: string }>> {
  if (!input.targetFolderTokens.length) return [];
  const hmrsRepo = new HmrsRepository();
  const context = hasValidUserOAuth(input.userId)
    ? { userId: input.userId, preferUserScope: true as const }
    : undefined;
  const maxDocs = input.maxDocsPerFolder ?? 8;
  const maxChars = input.maxCharsPerDoc ?? 12_000;
  const results: Array<{ token: string; title: string; content: string; url?: string }> = [];

  function flattenDocs(node: { files: { token: string; title: string }[]; subFolders: unknown[] }): Array<{ token: string; title: string }> {
    const docs = [...node.files];
    for (const sub of node.subFolders as Array<{ files: { token: string; title: string }[]; subFolders: unknown[] }>) {
      docs.push(...flattenDocs(sub));
    }
    return docs;
  }

  function isOperationalMetaDoc(title: string): boolean {
    const t = title.trim();
    return (
      t.includes("纳管记录_已纳管文档房间") ||
      t.includes("说明_纳管文档索引")
    );
  }

  for (const folderToken of input.targetFolderTokens) {
    // 递归读取：支持“近一周”子文件夹放在纳管根目录下的场景
    const tree = await hmrsRepo.listFolderStructure(input.userId, folderToken, 3).catch(() => null);
    const docs = tree
      ? flattenDocs(tree).filter((d) => !isOperationalMetaDoc(d.title)).slice(0, maxDocs)
      : [];
    for (const doc of docs) {
      const viewed = await toolGateway.viewDocument(doc.token, context).catch(() => null);
      const content = viewed?.content?.trim();
      const url = viewed?.url?.trim() || `https://jcneyh7qlo8i.feishu.cn/docx/${doc.token}`;
      if (content) {
        results.push({ token: doc.token, title: doc.title, content: content.slice(0, maxChars), url });
        logger.info("[detailRetrieval] 子文件夹文档读取成功", {
          userId: input.userId,
          folderToken,
          docToken: doc.token,
          title: doc.title,
          url,
          contentLen: content.length,
        });
      } else {
        logger.warn("[detailRetrieval] 子文件夹文档读取无内容", {
          userId: input.userId,
          folderToken,
          docToken: doc.token,
          title: doc.title,
        });
      }
    }
  }
  return results;
}

export async function fetchDetailByExpansion(input: {
  request: UserRequest;
  expandedL2Ids: string[];
  screened: CandidateResourceList;
  targetFolderTokens?: string[];
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

  // Step A：按 targetFolderTokens 从子文件夹直接读取文档正文（优先级最高）
  // 若 Planner 未选定文件夹，兜底扫描 env 中配置的纳管根文件夹
  const resolvedFolderTokens: string[] =
    (input.targetFolderTokens?.length ?? 0) > 0
      ? input.targetFolderTokens!
      : env.HMRS_MANAGED_FOLDER_TOKENS
        ? env.HMRS_MANAGED_FOLDER_TOKENS.split(",").map((t) => t.trim()).filter(Boolean)
        : [];

  if (input.request.userId && resolvedFolderTokens.length > 0) {
    const folderDocs = await fetchDocsFromFolders({
      userId: input.request.userId,
      targetFolderTokens: resolvedFolderTokens,
      maxDocsPerFolder: 16,
      maxCharsPerDoc: 12_000,
    });
    for (const doc of folderDocs) {
      const evidence = doc.url
        ? `飞书子文件夹文档：${doc.title}（原文链接：${doc.url}）`
        : `飞书子文件夹文档：${doc.title}`;
      facts.push(toFact(`folder_doc_${doc.token}`, doc.content, evidence));
      sourceDetails.push({
        resourceId: `folder_doc_${doc.token}`,
        detail: `【${doc.title}】\n原文链接：${doc.url ?? "（未知）"}\n${doc.content}`,
      });
    }
    if (folderDocs.length > 0) {
      logger.info("[detailRetrieval] 从目标子文件夹读取文档完成", {
        userId: input.request.userId,
        folderCount: resolvedFolderTokens.length,
        docCount: folderDocs.length,
        totalChars: folderDocs.reduce((s, d) => s + d.content.length, 0),
      });
    }
  }

  // Step B：按 L2 展开候选读取（与 Step A 互补，避免遗漏）
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
      const evidence = item.link
        ? `HMRS L3 按需展开正文摘录（原文链接：${item.link}）`
        : "HMRS L3 按需展开正文摘录";
      facts.push(toFact(item.resourceId, clipped, evidence));
      sourceDetails.push({
        resourceId: item.resourceId,
        detail: `原文链接：${item.link ?? "（未知）"}\n${content}`,
      });
      continue;
    }
    const fallbackEvidence = item.link
      ? `HMRS L3 展开失败，回退摘要（原文链接：${item.link}）`
      : "HMRS L3 展开失败，回退摘要";
    facts.push(toFact(item.resourceId, item.summary, fallbackEvidence));
    sourceDetails.push({
      resourceId: item.resourceId,
      detail: `【${item.title}】\n原文链接：${item.link ?? "（未知）"}\n${item.summary}`,
    });
  }

  // 检测 TemplateStructureIndex 候选，自动构建 TemplateProfile 注入 templateDistillation
  const templateDistillation = input.request.userId
    ? await buildTemplateDistillationFromExpanded({
        expandedL2Ids: input.expandedL2Ids,
        userId: input.request.userId,
      })
    : undefined;

  logger.info("[detailRetrieval] retrieval diagnostics", {
    userId: input.request.userId,
    facts: facts.length,
    sourceDetails: sourceDetails.length,
    resolvedFolderTokenCount: resolvedFolderTokens.length,
    expandedL2Count: input.expandedL2Ids.length,
    folderFactCount: facts.filter((f) => f.sourceId.startsWith("folder_doc_")).length,
    l2FactCount: facts.filter((f) => !f.sourceId.startsWith("folder_doc_")).length,
  });

  return DetailedContextSchema.parse({
    facts,
    sourceDetails,
    ...(templateDistillation ? { templateDistillation } : {}),
  });
}
