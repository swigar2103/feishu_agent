import { z } from "zod";
import type { TaskPlan, UserRequest } from "../schemas/index.js";
import { invokeBailianModel } from "../llm/client.js";
import { env } from "../config/env.js";
import type { ResourceCandidateRef, ResourceScreeningResult } from "./candidate_types.js";
import { ResourceScreeningResultSchema } from "./candidate_types.js";
import { ResourcePoolManager } from "./manager.js";
import type { DocumentSummary } from "./types.js";

const LlmPickSchema = z.object({
  documentIds: z.array(z.string()),
  contactIds: z.array(z.string()),
  projectIds: z.array(z.string()),
  personaUserIds: z.array(z.string()),
});

const CAPACITY = {
  documents: 6,
  contacts: 5,
  projects: 4,
  personas: 2,
} as const;

function tokenizeForOverlap(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const words = trimmed
    .split(/[\s,，.。!！?？《》【】、「」、；;:：'"“”()\[\]/\\-]+/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 2);
  const chineseChunks =
    trimmed.match(/[\u4e00-\u9fa5]{2,8}/gu)?.filter((chunk) => chunk.length >= 2) ?? [];
  return Array.from(new Set([...words, ...chineseChunks]));
}

function buildSignals(req: UserRequest, plan?: TaskPlan | null): string[] {
  const pieces = [
    req.prompt,
    req.industry ?? "",
    req.reportType ?? "",
    ...(plan?.targetSections ?? []),
    ...(plan?.useSources ?? []),
    ...(plan?.missingFields ?? []),
  ].filter(Boolean);
  return tokenizeForOverlap(pieces.join("\n")).slice(0, 120);
}

function scoreRow(textBlob: string, signals: string[]): number {
  let score = 0;
  const lower = textBlob.toLowerCase();
  for (const s of signals) {
    if (!s) continue;
    if (lower.includes(s.toLowerCase())) score += 1;
  }
  return score;
}

export function dedupeRefs(entries: ResourceCandidateRef[]): ResourceCandidateRef[] {
  const map = new Map<string, ResourceCandidateRef>();
  for (const item of entries) {
    const key = `${item.kind}:${item.id}`;
    const existed = map.get(key);
    if (!existed || existed.coarseScore < item.coarseScore) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => b.coarseScore - a.coarseScore);
}

function widenMandatoryCoverage(opts: {
  refs: ResourceCandidateRef[];
  docScoresSorted: Array<{ doc: DocumentSummary; score: number }>;
  contactScoresSorted: Array<{ entity: { id: string }; score: number }>;
  poolDocCount: number;
  poolContactCount: number;
}): ResourceCandidateRef[] {
  let out = dedupeRefs(opts.refs);
  if (opts.poolDocCount > 0 && !out.some((r) => r.kind === "document")) {
    const take = Math.min(2, opts.docScoresSorted.length);
    for (let i = 0; i < take; i++) {
      const doc = opts.docScoresSorted[i]?.doc;
      if (!doc) break;
      out.push({
        kind: "document",
        id: doc.id,
        coarseScore: 0.0005 + (opts.docScoresSorted[i]?.score ?? 0) / 10_000,
      });
    }
  }
  out = dedupeRefs(out);
  if (opts.poolContactCount > 0 && !out.some((r) => r.kind === "contact")) {
    const take = Math.min(2, opts.contactScoresSorted.length);
    for (let i = 0; i < take; i++) {
      const cid = opts.contactScoresSorted[i]?.entity.id;
      if (!cid) break;
      out.push({
        kind: "contact",
        id: cid,
        coarseScore: 0.0004,
      });
    }
  }
  return dedupeRefs(out);
}

async function llmSemanticPick(opts: {
  userRequest: UserRequest;
  taskPlan?: TaskPlan | null;
  manager: ResourcePoolManager;
}): Promise<ResourceCandidateRef[] | null> {
  try {
    const pool = opts.manager.getPool();
    const payload = {
      documents: pool.documents.map((d) => ({
        id: d.id,
        title: d.title,
        summary: d.summary,
        tags: d.tags,
      })),
      contacts: pool.contacts.map((c) => ({
        id: c.id,
        name: c.name,
        summary: c.summary,
        tags: c.tags,
      })),
      projects: pool.projects.map((p) => ({
        id: p.id,
        name: p.name,
        summary: p.summary,
        tags: p.tags,
      })),
      personas: pool.personas.map((p) => ({
        userId: p.userId,
        preferredTone: p.preferredTone,
        domains: p.domains,
      })),
    };

    const systemPrompt =
      '你是企业内部资料筛选器。仅从给定 JSON 的记录 id 中挑选与用户任务相关的条目。输出 JSON对象，字段：{"documentIds":[],"contactIds":[],"projectIds":[],"personaUserIds":[]} ，不要Markdown围栏。上限：文档<=6、联系人<=5、项目<=4、画像<=2；无相关内容则填空数组。';
    const userPrompt = JSON.stringify({
      prompt: opts.userRequest.prompt,
      plannerHints: opts.taskPlan
        ? {
            reportType: opts.taskPlan.reportType,
            useSources: opts.taskPlan.useSources,
          }
        : undefined,
      pool: payload,
    });

    const text = await invokeBailianModel({
      model: env.BAILIAN_MODEL_ORCHESTRATOR,
      systemPrompt,
      userPrompt,
      jsonMode: true,
    });
    const parsed = LlmPickSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      console.warn("[screening] LLM JSON 校验失败:", parsed.error);
      return null;
    }
    const refs: ResourceCandidateRef[] = [];
    const pick = parsed.data;
    for (const id of pick.documentIds) {
      refs.push({ kind: "document", id, coarseScore: 0.55 });
    }
    for (const id of pick.contactIds) {
      refs.push({ kind: "contact", id, coarseScore: 0.54 });
    }
    for (const id of pick.projectIds) {
      refs.push({ kind: "project", id, coarseScore: 0.53 });
    }
    for (const uid of pick.personaUserIds) {
      refs.push({ kind: "persona", id: uid, coarseScore: 0.52 });
    }
    return refs;
  } catch (error) {
    console.warn("[screening] LLM Fallback 不可用，保持兜底策略。", error);
    return null;
  }
}

/** B2：规则/关键字粗筛；覆盖不足再走 LLM 语义兜底 */
export async function runResourceScreening(opts: {
  manager: ResourcePoolManager;
  userRequest: UserRequest;
  taskPlan?: TaskPlan | null;
}): Promise<ResourceScreeningResult> {
  const signals = buildSignals(opts.userRequest, opts.taskPlan ?? null);
  const snapshot = opts.manager.getPool();

  const docScores = snapshot.documents.map((doc) => {
    const blob = `${doc.title} ${doc.summary} ${doc.tags.join(" ")}`;
    const base = scoreRow(blob, signals) * Math.max(doc.weight, 1);
    return { doc, score: base };
  });
  docScores.sort((a, b) => b.score - a.score);

  const contactScores = snapshot.contacts.map((c) => ({
    entity: c,
    score:
      scoreRow(`${c.name} ${c.summary} ${c.org ?? ""} ${c.role ?? ""}`, signals) *
      Math.max(c.weight, 1),
  }));
  contactScores.sort((a, b) => b.score - a.score);

  const projectScores = snapshot.projects.map((p) => ({
    entity: p,
    score:
      scoreRow(`${p.name} ${p.summary} ${p.tags.join(" ")}`, signals) *
      Math.max(p.weight, 1),
  }));
  projectScores.sort((a, b) => b.score - a.score);

  const personaScores = snapshot.personas.map((p) => ({
    entity: p,
    score:
      scoreRow(`${p.userId} ${p.preferredTone ?? ""} ${p.domains.join(" ")}`, signals) *
      Math.max(p.weight, 1),
  }));
  personaScores.sort((a, b) => b.score - a.score);

  const coarseRefs: ResourceCandidateRef[] = [];

  for (const item of docScores.slice(0, CAPACITY.documents)) {
    if (item.score > 0) {
      coarseRefs.push({ kind: "document", id: item.doc.id, coarseScore: item.score });
    }
  }
  for (const item of contactScores.slice(0, CAPACITY.contacts)) {
    if (item.score > 0) {
      coarseRefs.push({
        kind: "contact",
        id: item.entity.id,
        coarseScore: item.score,
      });
    }
  }
  for (const item of projectScores.slice(0, CAPACITY.projects)) {
    if (item.score > 0) {
      coarseRefs.push({
        kind: "project",
        id: item.entity.id,
        coarseScore: item.score,
      });
    }
  }

  const personaFromUser = opts.manager.personaByUserId(opts.userRequest.userId);
  if (personaFromUser) {
    coarseRefs.push({
      kind: "persona",
      id: personaFromUser.userId,
      coarseScore: Math.max(personaScores[0]?.score ?? 0, 0.01) + 1,
    });
  } else {
    for (const item of personaScores.slice(0, CAPACITY.personas)) {
      if (item.score > 0) {
        coarseRefs.push({
          kind: "persona",
          id: item.entity.userId,
          coarseScore: item.score,
        });
      }
    }
  }

  let merged = dedupeRefs(coarseRefs);
  merged = widenMandatoryCoverage({
    refs: merged,
    docScoresSorted: docScores,
    contactScoresSorted: contactScores,
    poolDocCount: snapshot.documents.length,
    poolContactCount: snapshot.contacts.length,
  });

  let llmUsed = false;
  const poolNonEmpty =
    snapshot.documents.length +
      snapshot.contacts.length +
      snapshot.projects.length +
      snapshot.personas.length >
    0;
  if (merged.length === 0 && poolNonEmpty) {
    const llmRefs = await llmSemanticPick({
      userRequest: opts.userRequest,
      taskPlan: opts.taskPlan ?? null,
      manager: opts.manager,
    });
    if (llmRefs && llmRefs.length > 0) {
      llmUsed = true;
      merged = dedupeRefs([...merged, ...llmRefs]);
    }
  }

  merged = widenMandatoryCoverage({
    refs: merged,
    docScoresSorted: docScores,
    contactScoresSorted: contactScores,
    poolDocCount: snapshot.documents.length,
    poolContactCount: snapshot.contacts.length,
  });

  const finalList = dedupeRefs(merged);

  return ResourceScreeningResultSchema.parse({
    candidates: finalList,
    llmFallbackUsed: llmUsed,
    trace: {
      keywordSignals: signals,
      coarseCounts: {
        documents: finalList.filter((c) => c.kind === "document").length,
        contacts: finalList.filter((c) => c.kind === "contact").length,
        projects: finalList.filter((c) => c.kind === "project").length,
        personas: finalList.filter((c) => c.kind === "persona").length,
      },
    },
  });
}
