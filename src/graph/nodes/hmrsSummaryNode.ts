import { CandidateResourceListSchema, ResourceSummarySchema, type ResourceSummary } from "../../schemas/agentContracts.js";
import { deriveMcpDocumentSearchQueries } from "../../services/resourcePool/mcpSearchQueries.js";
import { toolGateway } from "../../services/toolGateway/gateway.js";
import { hasValidUserOAuth } from "../../storage/userOAuthStore.js";
import { readHmrsTaskType } from "../../services/hmrs/flags/hmrsFeatureFlags.js";
import { getMemoryFacade } from "../../services/hmrs/facade/memoryFacade.js";
import { logHmrsDiff } from "../../services/hmrs/observe/hmrsDiffLogger.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import type { ReportGraphStateType } from "../state.js";

function toResourceSummary(
  doc: Awaited<ReturnType<typeof toolGateway.searchDocuments>>[number],
): ResourceSummary {
  const title = (doc.title || doc.id || "未命名文档").trim();
  const summary = (doc.summary ?? doc.content ?? "").trim() || `文档候选：${title}`;
  return ResourceSummarySchema.parse({
    resourceId: `ext_doc_${doc.id}`,
    resourceType: "doc_summary",
    title,
    summary,
    project: "外部文档",
    tags: ["hmrs", doc.source ?? "unknown"],
    keywords: `${doc.title ?? ""} ${doc.summary ?? ""}`
      .split(/[，。,\s]/)
      .filter(Boolean)
      .slice(0, 12),
    updatedAt: new Date().toISOString(),
    link: doc.url,
    score: 0.35,
  });
}

function ensureNonEmptySummary(resource: ResourceSummary): ResourceSummary {
  const title = resource.title.trim() || resource.resourceId;
  const summary = resource.summary?.trim() || `资源候选：${title}`;
  return ResourceSummarySchema.parse({
    ...resource,
    title,
    summary,
  });
}

function buildInlineResources(state: ReportGraphStateType): ResourceSummary[] {
  if (!state.taskRequest) return [];
  const request = state.taskRequest.userRequest;
  const history = request.historyDocs.map((doc, idx) =>
    ResourceSummarySchema.parse({
      resourceId: `history_${idx + 1}`,
      resourceType: "project_memory",
      title: `历史材料 ${idx + 1}`,
      summary: doc.trim() || `历史材料 ${idx + 1}（内容待补充）`,
      project: request.industry ?? "通用项目",
      tags: ["hmrs", "history"],
      keywords: doc.split(/[，。,\s]/).filter(Boolean).slice(0, 12),
      updatedAt: new Date().toISOString(),
      score: 0.3,
    }),
  );
  const personal = request.personalKnowledge.map((item, idx) =>
    ResourceSummarySchema.parse({
      resourceId: `pk_${idx + 1}`,
      resourceType: "project_memory",
      title: `个人知识 ${idx + 1}`,
      summary: item.trim() || `个人知识 ${idx + 1}（内容待补充）`,
      project: request.industry ?? "通用项目",
      tags: ["hmrs", "personal_knowledge"],
      keywords: item.split(/[，。,\s]/).filter(Boolean).slice(0, 12),
      updatedAt: new Date().toISOString(),
      score: 0.28,
    }),
  );
  const contacts = request.imContacts.map((contact, idx) =>
    ResourceSummarySchema.parse({
      resourceId: `im_contact_${idx + 1}_${contact.id}`,
      resourceType: "contact_summary",
      title: `${contact.name} 联系人`,
      summary: `联系人 ${contact.name}(${contact.id})，角色=${contact.role ?? "未知"}`,
      project: request.industry ?? "通用项目",
      tags: ["hmrs", "im_contact"],
      keywords: [contact.name, contact.role ?? "联系人"].filter(Boolean),
      updatedAt: new Date().toISOString(),
      score: 0.24,
    }),
  );
  return [...history, ...personal, ...contacts];
}

async function fetchCloudDocResources(state: ReportGraphStateType): Promise<ResourceSummary[]> {
  if (!state.taskRequest) return [];
  const request = state.taskRequest.userRequest;
  const context = request.userId
    ? { userId: request.userId, preferUserScope: hasValidUserOAuth(request.userId) }
    : undefined;
  const queries = deriveMcpDocumentSearchQueries(request.prompt);
  const seen = new Set<string>();
  const docs: Awaited<ReturnType<typeof toolGateway.searchDocuments>> = [];
  for (const query of queries) {
    const batch = await toolGateway.searchDocuments(query, context).catch(() => []);
    for (const doc of batch) {
      if (!doc.id || seen.has(doc.id)) continue;
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  return docs.slice(0, 10).map(toResourceSummary);
}

export async function hmrsSummaryNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  if (!state.taskRequest) {
    throw new Error("hmrs_summary 缺少 taskRequest");
  }
  const request = state.taskRequest.userRequest;
  const facade = getMemoryFacade();
  const refreshResult = await facade.refreshManagedFolders({ userId: request.userId }).catch(() => null);
  const cloudResources = await fetchCloudDocResources(state);
  const inlineResources = buildInlineResources(state);
  const resourcePool = [...cloudResources, ...inlineResources].map(ensureNonEmptySummary);
  await facade.ingestResourcePool(request, resourcePool);
  const l1 = await facade.queryWingSummaries({
    owner: request.userId,
    keyword: request.prompt,
    wings: ["projects_wing", "resources_wing", "people_wing", "templates_wing"],
    limit: 10,
  });
  const l1ResourceIds = new Set(l1.slice(0, 8).map((item) => item.id.replace(/^l1_/, "")));
  const hmrsCandidates = resourcePool
    .filter((item) => l1ResourceIds.has(item.resourceId))
    .map(ensureNonEmptySummary);
  const candidateResources = CandidateResourceListSchema.parse({
    candidates:
      hmrsCandidates.length > 0
        ? hmrsCandidates
        : resourcePool.slice(0, 8).map(ensureNonEmptySummary),
    usedLlmFallback: false,
    screeningReason: [
      `hmrs_cloud_docs=${cloudResources.length}`,
      `hmrs_inline=${inlineResources.length}`,
      `hmrs_l1=${l1.length}`,
      `hmrs_managed_folders=${refreshResult?.managedFolderCount ?? 0}`,
      `hmrs_ingested_docs=${refreshResult?.ingestedDocCount ?? 0}`,
    ],
  });

  logHmrsDiff({
    sessionId: request.sessionId,
    userId: request.userId,
    taskType: readHmrsTaskType(request),
    legacyTopIds: [],
    hmrsL1Ids: l1.map((item) => item.id),
    hmrsL2Ids: [],
    finalExpansionIds: [],
    budget: { maxItems: 0, maxChars: 0 },
  });
  publishPipelineProgress({
    sessionId: request.sessionId,
    stage: "hmrs_summary",
    message: "资源筛选完成",
    meta: {
      l1Count: l1.length,
      candidateCount: candidateResources.candidates.length,
      cloudDocCount: cloudResources.length,
    },
  });

  return {
    resourcePool,
    candidateResources,
    debugTrace: [
      `[hmrs_summary] taskType=${readHmrsTaskType(request)} l1=${l1.length} candidates=${candidateResources.candidates.length}`,
    ],
  };
}
