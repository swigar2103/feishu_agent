import { CandidateResourceListSchema, ResourceSummarySchema, type ResourceSummary } from "../../schemas/agentContracts.js";
import { readHmrsTaskType } from "../../services/hmrs/flags/hmrsFeatureFlags.js";
import { getMemoryFacade } from "../../services/hmrs/facade/memoryFacade.js";
import { logHmrsDiff } from "../../services/hmrs/observe/hmrsDiffLogger.js";
import { publishPipelineProgress } from "../../services/progress/pipelineProgress.js";
import { screenResources } from "../../services/resourcePool/screening.js";
import type { ReportGraphStateType } from "../state.js";

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
  const facade = getMemoryFacade();
  const trees = await facade.getManagedFolderStructure(request.userId).catch(() => []);
  const rows: ResourceSummary[] = [];
  const pushFromNode = (node: { token: string; name: string; files: { token: string; title: string }[]; subFolders: unknown[] }) => {
    for (const file of node.files.slice(0, 30)) {
      rows.push(
        ResourceSummarySchema.parse({
          resourceId: `ext_doc_${file.token}`,
          resourceType: "doc_summary",
          title: file.title,
          summary: `纳管目录文档：${file.title}（来源文件夹：${node.name}）`,
          project: "纳管文档",
          tags: ["hmrs", "managed", `folder_${node.token}`],
          keywords: `${file.title} ${node.name}`.split(/[，。,\s]/).filter(Boolean).slice(0, 12),
          updatedAt: new Date().toISOString(),
          link: `https://jcneyh7qlo8i.feishu.cn/docx/${file.token}`,
          score: 0.42,
        }),
      );
    }
    for (const sub of node.subFolders as Array<{ token: string; name: string; files: { token: string; title: string }[]; subFolders: unknown[] }>) {
      pushFromNode(sub);
    }
  };
  for (const tree of trees) pushFromNode(tree);
  return rows;
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
  const screening = await screenResources({
    request,
    resourcePool,
  });
  const candidateResources = CandidateResourceListSchema.parse({
    ...screening,
    screeningReason: [
      `hmrs_cloud_docs=${cloudResources.length}`,
      `hmrs_inline=${inlineResources.length}`,
      `hmrs_l1=${l1.length}`,
      `hmrs_managed_folders=${refreshResult?.managedFolderCount ?? 0}`,
      `hmrs_ingested_docs=${refreshResult?.ingestedDocCount ?? 0}`,
      ...screening.screeningReason,
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
      selectionDecision: candidateResources.selectionDecision
        ? {
            selected: candidateResources.selectionDecision.selectedResourceIds.length,
            allowGlobalSupplement: candidateResources.selectionDecision.allowGlobalSupplement,
            insufficient: candidateResources.selectionDecision.insufficient,
          }
        : undefined,
    },
  });

  return {
    resourcePool,
    candidateResources,
    debugTrace: [
      `[hmrs_summary] taskType=${readHmrsTaskType(request)} l1=${l1.length} candidates=${candidateResources.candidates.length} insufficient=${candidateResources.selectionDecision?.insufficient ?? false} allowGlobal=${candidateResources.selectionDecision?.allowGlobalSupplement ?? false}`,
    ],
  };
}
