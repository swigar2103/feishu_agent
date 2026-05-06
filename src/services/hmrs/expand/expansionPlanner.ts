import type { ExecutionPlan } from "../../../schemas/agentContracts.js";
import type { L1CatalogObject, L2IndexObject } from "../model/layerSchemas.js";
import {
  buildRecallBudget,
  trimByBudget,
  type ExpansionCandidate,
  type RecallBudget,
  type RecallBudgetHint,
} from "../budget/recallBudgetService.js";

export type ExpansionDecision = {
  l1Ids: string[];
  l2Ids: string[];
  finalResourceIds: string[];
  reason: string[];
  budget: RecallBudget;
};

function scoreL2(l2: L2IndexObject, plan: ExecutionPlan): number {
  const sectionText = plan.targetSections.join(" ");
  const hits = l2.structureSummary
    .split(/[，。,\s]/)
    .filter((token) => token.length >= 2)
    .reduce((sum, token) => sum + (sectionText.includes(token) ? 1 : 0), 0);
  return Math.min(1, l2.qualityScore * 0.7 + hits * 0.08);
}

export function buildExpansionDecision(input: {
  plan: ExecutionPlan;
  l1: L1CatalogObject[];
  l2: L2IndexObject[];
  budgetHint?: RecallBudgetHint;
}): ExpansionDecision {
  const budget = buildRecallBudget(input.budgetHint);
  const roomSeen = new Set<string>();
  const expanded: ExpansionCandidate[] = input.l2.map((item) => {
    const room = item.roomId ?? "unknown_room";
    const roomBoost = roomSeen.has(room) ? 0 : 0.05;
    roomSeen.add(room);
    return {
    id: item.id,
    title: item.title,
    score: Math.min(1, scoreL2(item, input.plan) + roomBoost),
    expectedChars: Math.max(800, Math.min(5_000, item.structureSummary.length * 2)),
    };
  });
  const selected = trimByBudget(expanded, budget);
  const selectedRoomCount = new Set(
    input.l2.filter((item) => selected.some((x) => x.id === item.id)).map((item) => item.roomId ?? "unknown_room"),
  ).size;
  return {
    l1Ids: input.l1.map((item) => item.id),
    l2Ids: input.l2.map((item) => item.id),
    finalResourceIds: selected.map((item) => item.id),
    reason: [
      `l1=${input.l1.length}`,
      `l2=${input.l2.length}`,
      `rooms_selected=${selectedRoomCount}`,
      `budget_max_items=${budget.maxItems}`,
      `budget_max_chars=${budget.maxChars}`,
    ],
    budget,
  };
}
