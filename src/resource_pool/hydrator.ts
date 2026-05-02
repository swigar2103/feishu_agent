import type { TaskPlan } from "../schemas/index.js";
import type { ResourceDataAdapter } from "./feishu/adapterTypes.js";
import type { ResourceScreeningResult } from "./candidate_types.js";
import type { HydratedTaskContextPack } from "./context_pack.js";
import { HydratedTaskContextPackSchema } from "./context_pack.js";
import { ResourcePoolManager } from "./manager.js";

/** B3：候选 ref → 适配器拉取正文/详情，拼装可交给下游（C / A）消费的任务上下文包 */
export async function hydrateTaskContext(opts: {
  manager: ResourcePoolManager;
  screening: ResourceScreeningResult;
  adapter: ResourceDataAdapter;
  /** 仅用于签名/排查，可传 Planner 概要 */
  taskPlan?: TaskPlan | null;
  /** 仅在显式传入时附加 IM 线程摘要（演示可传 `thread_pay_jump_discussion_mock`） */
  attachSampleImThreadId?: string | null;
}): Promise<HydratedTaskContextPack> {
  const docChunks: HydratedTaskContextPack["documents"] = [];
  const contactChunks: HydratedTaskContextPack["contacts"] = [];
  const projectChunks: HydratedTaskContextPack["projects"] = [];
  const personaChunks: HydratedTaskContextPack["personas"] = [];

  const notes: string[] = [];
  const signatureParts: string[] = [];

  for (const ref of opts.screening.candidates) {
    signatureParts.push(`${ref.kind}:${ref.id}`);
    if (ref.kind === "document") {
      const summary = opts.manager.documentById(ref.id);
      if (!summary) {
        notes.push(`[hydrator] 未找到文档摘要 id=${ref.id}`);
        continue;
      }
      const detail = await opts.adapter.loadDocumentOutlineAndBody(summary);
      docChunks.push({
        resourceId: ref.id,
        title: summary.title,
        outline: detail.outline,
        body: detail.bodyMarkdown.slice(0, 24_000),
      });
      if (detail.directoryEntries.length) {
        notes.push(
          `[hydrator] doc ${ref.id} 目录节点=${detail.directoryEntries.length}`,
        );
      }
      continue;
    }
    if (ref.kind === "contact") {
      const summary = opts.manager.contactById(ref.id);
      if (!summary) {
        notes.push(`[hydrator] 未找到联系人 id=${ref.id}`);
        continue;
      }
      const text = await opts.adapter.loadContactExtendedDetail(ref.id);
      contactChunks.push({
        resourceId: ref.id,
        name: summary.name,
        detailText: `${summary.summary}\n\n${text}`,
      });
      continue;
    }
    if (ref.kind === "project") {
      const summary = opts.manager.projectById(ref.id);
      if (!summary) {
        notes.push(`[hydrator] 未找到项目 id=${ref.id}`);
        continue;
      }
      const text = await opts.adapter.loadProjectExtendedDetail(ref.id);
      projectChunks.push({
        resourceId: ref.id,
        name: summary.name,
        detailText: `${summary.summary}\n\n${text}`,
      });
      continue;
    }
    if (ref.kind === "persona") {
      const persona = opts.manager.personaByUserId(ref.id);
      if (!persona) {
        notes.push(`[hydrator] 未找到用户画像 userId=${ref.id}`);
        continue;
      }
      const briefing = [
        persona.preferredTone ? `语气偏好：${persona.preferredTone}` : null,
        persona.domains.length ? `领域：${persona.domains.join("、")}` : null,
        persona.styleNotes.length ? `风格备注：${persona.styleNotes.join("；")}` : null,
        persona.commonTerms.length ? `常用术语：${persona.commonTerms.join("、")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      personaChunks.push({ userId: persona.userId, briefingText: briefing });
    }
  }

  const threadId = opts.attachSampleImThreadId ?? null;
  if (threadId) {
    const digest = await opts.adapter.loadMessageThreadDigest(threadId);
    notes.push(`[hydrator] IM thread ${threadId}: ${digest.slice(0, 280)}`);
  }

  notes.push(
    `[hydrator] Planner reportType=${opts.taskPlan?.reportType ?? "n/a"} useSources=${
      opts.taskPlan?.useSources?.length ?? 0
    }`,
  );

  return HydratedTaskContextPackSchema.parse({
    screeningSignature: signatureParts.sort().join("|").slice(0, 1024),
    documents: docChunks,
    contacts: contactChunks,
    projects: projectChunks,
    personas: personaChunks,
    debugNotes: notes,
  });
}
