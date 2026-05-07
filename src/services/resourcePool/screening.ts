import { z } from "zod";
import {
  CandidateResourceListSchema,
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

const LlmScreeningSchema = z.object({
  selectedResourceIds: z.array(z.string()).default([]),
  reason: z.array(z.string()).default([]),
});

async function llmFallbackScreening(
  request: UserRequest,
  resourcePool: ResourceSummary[],
): Promise<{ selectedResourceIds: string[]; reason: string[] }> {
  const compact = resourcePool.slice(0, 20).map((r) => ({
    resourceId: r.resourceId,
    title: r.title,
    summary: r.summary,
    tags: r.tags,
  }));

  try {
    const result = await invokeJsonModel(LlmScreeningSchema, {
      systemPrompt: [
        "你是 Resource Screening Agent。",
        "请基于任务请求从资源摘要中选择最值得深读的资源ID列表。",
        "只返回 JSON。",
      ].join("\n"),
      userPrompt: `request=${JSON.stringify(request)}\nresourcePool=${JSON.stringify(compact)}`,
    });
    return LlmScreeningSchema.parse(result);
  } catch {
    return { selectedResourceIds: [], reason: ["LLM fallback 失败，回退规则筛选"] };
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

  const ruleCandidates = scored.filter((item) => (item.score ?? 0) >= 0.25).slice(0, 8);
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

  if (!needExternalSupplement) {
    return CandidateResourceListSchema.parse({
      candidates: ruleCandidates.map(normalizeResourceSummary),
      usedLlmFallback: false,
      screeningReason: reasons,
    });
  }

  const llm = await llmFallbackScreening(input.request, scored);
  const llmSet = new Set(llm.selectedResourceIds);
  const llmCandidates = scored.filter((resource) => llmSet.has(resource.resourceId)).slice(0, 8);
  const mergedBase: ResourceSummary[] =
    llmCandidates.length > 0 ? llmCandidates : scored.slice(0, 5);
  let merged: ResourceSummary[] = mergedBase;
  const screeningReason = [...reasons, ...llm.reason];

  if (needExternalSupplement) {
    const external = await fetchExternalCandidates(input.request.prompt, input.request.userId);
    const existing = new Set(merged.map((item) => item.resourceId));
    const supplements = external.filter((item) => !existing.has(item.resourceId));
    merged = [...merged, ...supplements].slice(0, 8);
    screeningReason.push(`外部工具补充候选=${supplements.length}`);
  }

  return CandidateResourceListSchema.parse({
    candidates: merged.map(normalizeResourceSummary),
    usedLlmFallback: true,
    screeningReason,
  });
}
