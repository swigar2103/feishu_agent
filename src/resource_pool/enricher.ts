import { z } from "zod";
import type { ResourceCandidateRef } from "./candidate_types.js";
import type {
  ContactSummary,
  DocumentSummary,
  PersonaSummary,
  ProjectSummary,
  ResourcePoolSnapshot,
} from "./types.js";
import { ResourcePoolSnapshotSchema } from "./types.js";
import { ResourcePoolManager } from "./manager.js";

export const UsageEvidenceSchema = z.object({
  kind: z.enum(["document", "contact", "project", "persona"]),
  id: z.string().min(1),
  delta: z.number().positive().optional().default(0.35),
});

export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>;

function bumpRow(
  row: DocumentSummary | ContactSummary | ProjectSummary | PersonaSummary,
  delta: number,
): void {
  row.weight = Number((Math.max(row.weight, 1) + delta).toFixed(3));
}

/** B4：按「本次确有贡献」提高条目 weight，返回全新 Manager（可再 replacePool 或由 A 挂载单例）。 */
export function applyResourceUsage(
  manager: ResourcePoolManager,
  rawEvidence: UsageEvidence[],
): ResourcePoolManager {
  const evidences = rawEvidence.map((row) => UsageEvidenceSchema.parse(row));
  let snap = structuredClone(manager.getPool()) as ResourcePoolSnapshot;

  for (const ev of evidences) {
    if (ev.kind === "document") {
      const row = snap.documents.find((d) => d.id === ev.id);
      if (row) bumpRow(row, ev.delta);
      continue;
    }
    if (ev.kind === "contact") {
      const row = snap.contacts.find((c) => c.id === ev.id);
      if (row) bumpRow(row, ev.delta);
      continue;
    }
    if (ev.kind === "project") {
      const row = snap.projects.find((p) => p.id === ev.id);
      if (row) bumpRow(row, ev.delta);
      continue;
    }
    const row = snap.personas.find((p) => p.userId === ev.id);
    if (row) bumpRow(row, ev.delta);
  }

  return new ResourcePoolManager(ResourcePoolSnapshotSchema.parse(snap));
}

/** 便于 A 在主流程末尾：把本轮筛选命中的 id 转成 B4 Evidence（默认正向增量）。 */
export function usageEvidenceFromScreeningCandidates(
  candidates: ResourceCandidateRef[],
  delta = 0.28,
): UsageEvidence[] {
  return candidates.map((c) => ({
    kind: c.kind,
    id: c.id,
    delta,
  }));
}
