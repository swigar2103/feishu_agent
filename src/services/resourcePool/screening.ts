import { z } from "zod";
import {
  CandidateResourceListSchema,
  ResourceSelectionDecisionSchema,
  type CandidateResourceList,
  type ResourceSummary,
} from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { invokeJsonModel } from "../../llm/jsonModel.js";
import { env } from "../../config/env.js";
import { toolGateway } from "../toolGateway/gateway.js";
import { expandMemPalaceTerms } from "./memPalace.js";
import { deriveMcpDocumentSearchQueries } from "./mcpSearchQueries.js";
import { hasValidUserOAuth } from "../../storage/userOAuthStore.js";
import { detectDocumentPollution } from "../../shared/evidenceQuality.js";
import { logger } from "../../shared/logger.js";

function scoreByRules(prompt: string, resource: ResourceSummary): number {
  const lowerPrompt = prompt.toLowerCase();
  const text = `${resource.title} ${resource.summary} ${resource.tags.join(" ")} ${resource.keywords.join(" ")}`.toLowerCase();
  const hits = lowerPrompt
    .split(/\s+/)
    .filter((token) => token.length > 1)
    .reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
  const normalized = Math.min(1, hits / 5);
  return normalized;
}

function normalizeResourceSummary(resource: ResourceSummary): ResourceSummary {
  const title = resource.title?.trim() || resource.resourceId;
  const summary = resource.summary?.trim() || `资源候选：${title}`;
  return {
    ...resource,
    title,
    summary,
  };
}

const LlmScreeningSchema = ResourceSelectionDecisionSchema.extend({
  decisionReasons: z.array(z.string()).default([]),
});

async function llmFallbackScreening(input: {
  request: UserRequest,
  resourcePool: ResourceSummary[];
  stage: "managed_only" | "managed_plus_global";
}): Promise<z.infer<typeof LlmScreeningSchema>> {
  const compact = input.resourcePool.slice(0, 30).map((r) => ({
    resourceId: r.resourceId,
    title: r.title,
    summary: r.summary,
    tags: r.tags,
    score: r.score ?? 0,
  }));

  try {
    const result = await invokeJsonModel(LlmScreeningSchema, {
      systemPrompt: [
        "你是 Resource Screening Agent。",
        "你需要根据任务意图，自主选择最值得深读的资源。",
        "规则：",
        "1) 优先使用纳管目录资源（tags 含 managed）。",
        "2) 仅在证据不足时，才允许选择 global_mcp 资源（tags 含 external/global_mcp）。",
        "3) 必须输出 sectionResourceMapping，说明每个章节为什么选这些资源。",
        "4) 若证据不足，请将 insufficient=true，并给出 insufficiencyReasons。",
        `5) 当前阶段=${input.stage}；当阶段是 managed_only 时，allowGlobalSupplement 仅在确实证据不足时置 true。`,
        "只返回 JSON。",
      ].join("\n"),
      userPrompt: `request=${JSON.stringify(input.request)}\nresourcePool=${JSON.stringify(compact)}`,
    });
    return LlmScreeningSchema.parse(result);
  } catch {
    return LlmScreeningSchema.parse({
      selectedResourceIds: [],
      sectionResourceMapping: [],
      insufficient: false,
      insufficiencyReasons: [],
      allowGlobalSupplement: false,
      decisionReasons: ["LLM fallback 失败，回退规则筛选"],
    });
  }
}

function mapDocToResourceSummary(
  doc: Awaited<ReturnType<typeof toolGateway.searchDocuments>>[number],
): ResourceSummary {
  const sourceTag = doc.source ?? "unknown";
  const fallbackTitle = (doc.title || doc.id || "未命名文档").trim();
  /**
   * 深读后 doc.content 即为正文（已被 MCP adapter 截断到 8K）。
   * 优先使用正文做 summary，让 Writer 拿到第一手 evidence；正文缺失时退回 search-doc snippet。
   */
  const deepBody = (doc.content ?? "").trim();
  const snippet = (doc.summary ?? "").trim();
  const summary = deepBody || snippet || `文档候选：${fallbackTitle}`;
  const score = deepBody ? 0.55 : 0.32;
  return {
    resourceId: `ext_doc_${doc.id}`,
    resourceType: "doc_summary",
    title: fallbackTitle,
    summary,
    project: "外部文档",
    tags: ["external", sourceTag, deepBody ? "deep_fetched" : "snippet_only"],
    keywords: `${doc.title} ${snippet}`
      .split(/[，。,\s]/)
      .filter(Boolean)
      .slice(0, 8),
    updatedAt: new Date().toISOString(),
    link: doc.url,
    score,
  };
}

function mapUserToResourceSummary(
  user: Awaited<ReturnType<typeof toolGateway.searchUsers>>[number],
): ResourceSummary {
  const sourceTag = user.source ?? "unknown";
  return {
    resourceId: `ext_user_${user.id}`,
    resourceType: "contact_summary",
    title: user.name,
    summary: `用户信息：${user.name} ${user.role ?? ""} ${user.department ?? ""}`.trim(),
    project: "人员资源",
    tags: ["external", "user", sourceTag],
    keywords: [user.name, user.role ?? "", user.department ?? ""].filter(Boolean),
    updatedAt: new Date().toISOString(),
    score: 0.3,
  };
}

async function fetchExternalCandidates(query: string, userId?: string): Promise<ResourceSummary[]> {
  const context = userId?.trim()
    ? { userId: userId.trim(), preferUserScope: hasValidUserOAuth(userId) }
    : undefined;
  const queries = deriveMcpDocumentSearchQueries(query);
  const seenDoc = new Set<string>();
  const docs: Awaited<ReturnType<typeof toolGateway.searchDocuments>> = [];
  for (const q of queries) {
    const batch = await toolGateway.searchDocuments(q, context).catch(() => []);
    for (const d of batch) {
      if (d.id && !seenDoc.has(d.id)) {
        seenDoc.add(d.id);
        docs.push(d);
      }
    }
  }
  /**
   * Adapter 已在 deepFetch 阶段做了一次污染丢弃；这里基于 (title + content) 再过一遍：
   * 兼容 listDocuments / 旧版 adapter 未做深读的情况，确保到达 Writer 前的 ext_doc 不是失败日志。
   */
  let droppedByPollution = 0;
  const cleanedDocs: typeof docs = [];
  for (const d of docs) {
    const verdict = detectDocumentPollution({
      title: d.title ?? "",
      content: (d.content ?? d.summary ?? "").trim(),
    });
    if (verdict.polluted) {
      droppedByPollution += 1;
      continue;
    }
    cleanedDocs.push(d);
  }
  if (droppedByPollution > 0) {
    logger.warn("[screening] dropped polluted external docs before mapping to resource pool", {
      droppedByPollution,
      kept: cleanedDocs.length,
    });
  }

  const userQuery = queries[0] ?? query;
  const users = await toolGateway.searchUsers(userQuery, context).catch(() => []);

  return [
    ...cleanedDocs.slice(0, 4).map(mapDocToResourceSummary),
    ...users.slice(0, 3).map(mapUserToResourceSummary),
  ];
}

function mentionSoftBoost(
  resource: ResourceSummary,
  mentioned: string[] | undefined,
): number {
  if (!mentioned?.length) return 0;
  return mentioned.includes(resource.resourceId) ? 0.28 : 0;
}

export async function screenResources(input: {
  request: UserRequest;
  resourcePool: ResourceSummary[];
}): Promise<CandidateResourceList> {
  const normalizedPool = input.resourcePool.map(normalizeResourceSummary);
  const { extraTerms } = expandMemPalaceTerms(input.request.prompt);
  const extraForScreening = (input.request.extraContext ?? []).join("\n").slice(0, 8_000);
  const palaceAugmentedPrompt = [
    input.request.prompt,
    input.request.chatPriorArtifactDigest ?? "",
    extraForScreening,
    ...extraTerms,
  ].join(" ");

  const mentioned = input.request.mentionedResourceIds ?? [];

  const scored = normalizedPool
    .map((resource) => {
      const base = scoreByRules(palaceAugmentedPrompt, resource);
      const soft = mentionSoftBoost(resource, mentioned);
      return {
        ...resource,
        score: Math.min(1, base + soft),
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const ruleCandidates = scored.filter((item) => (item.score ?? 0) >= 0.25).slice(0, 12);
  const topN = ruleCandidates.slice(0, 3);
  const avgTopScore =
    topN.length > 0 ? topN.reduce((sum, item) => sum + (item.score ?? 0), 0) / topN.length : 0;
  const needExternalSupplement =
    ruleCandidates.length < env.RESOURCE_SCREENING_MIN_CANDIDATE_COUNT ||
    avgTopScore < env.RESOURCE_SCREENING_MIN_CANDIDATE_SCORE;
  const { matchedRoomIds } = expandMemPalaceTerms(input.request.prompt);
  const reasons = [
    `规则筛选命中=${ruleCandidates.length}`,
    `规则候选top3均分=${avgTopScore.toFixed(3)}`,
    `阈值count=${env.RESOURCE_SCREENING_MIN_CANDIDATE_COUNT} score=${env.RESOURCE_SCREENING_MIN_CANDIDATE_SCORE}`,
    `memPalace_rooms=${matchedRoomIds.join("|") || "—"}`,
    `mention_soft=${mentioned.length}`,
  ];

  // 先做 managed-only 决策（让 LLM 自主选择资源）
  const managedUniverse = ruleCandidates.filter((item) => item.tags.includes("managed"));
  const managedPool = managedUniverse.length > 0 ? managedUniverse : ruleCandidates;
  const managedDecision = await llmFallbackScreening({
    request: input.request,
    resourcePool: managedPool,
    stage: "managed_only",
  });
  const managedSet = new Set(managedDecision.selectedResourceIds);
  const managedSelected = managedPool.filter((item) => managedSet.has(item.resourceId)).slice(0, 8);

  if (!managedDecision.allowGlobalSupplement && managedSelected.length > 0) {
    return CandidateResourceListSchema.parse({
      candidates: managedSelected.map(normalizeResourceSummary),
      usedLlmFallback: true,
      screeningReason: [...reasons, ...managedDecision.decisionReasons, "采用 managed-only 选择结果"],
      selectionDecision: managedDecision,
    });
  }

  const mergedBase: ResourceSummary[] =
    managedSelected.length > 0 ? managedSelected : managedPool.slice(0, 6);
  let merged: ResourceSummary[] = mergedBase;
  const screeningReason = [...reasons, ...managedDecision.decisionReasons];

  if (needExternalSupplement || managedDecision.allowGlobalSupplement || managedDecision.insufficient) {
    const external = await fetchExternalCandidates(input.request.prompt, input.request.userId);
    const existing = new Set(merged.map((item) => item.resourceId));
    const supplements = external
      .filter((item) => !existing.has(item.resourceId))
      .map((item) => ({
        ...item,
        tags: [...item.tags, "global_mcp"],
      }));
    const mergedUniverse = [...managedPool, ...supplements].slice(0, 20);
    const secondDecision = await llmFallbackScreening({
      request: input.request,
      resourcePool: mergedUniverse,
      stage: "managed_plus_global",
    });
    const selectedSet = new Set(secondDecision.selectedResourceIds);
    const selected = mergedUniverse.filter((item) => selectedSet.has(item.resourceId)).slice(0, 8);
    merged = selected.length > 0 ? selected : mergedUniverse.slice(0, 8);
    screeningReason.push(`外部工具补充候选=${supplements.length}`);
    screeningReason.push(...secondDecision.decisionReasons);
    screeningReason.push(
      `selection_summary(managed=${merged.filter((x) => x.tags.includes("managed")).length},global=${merged.filter((x) => x.tags.includes("global_mcp")).length})`,
    );
    return CandidateResourceListSchema.parse({
      candidates: merged.map(normalizeResourceSummary),
      usedLlmFallback: true,
      screeningReason,
      selectionDecision: secondDecision,
    });
  }

  return CandidateResourceListSchema.parse({
    candidates: merged.map(normalizeResourceSummary),
    usedLlmFallback: true,
    screeningReason,
    selectionDecision: managedDecision,
  });
}
