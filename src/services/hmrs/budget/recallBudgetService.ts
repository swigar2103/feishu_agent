import { env } from "../../../config/env.js";

export type RecallBudgetHint = {
  maxItems?: number;
  maxChars?: number;
  priority?: "balanced" | "precision" | "coverage";
};

export type RecallBudget = {
  maxItems: number;
  maxChars: number;
  priority: "balanced" | "precision" | "coverage";
};

export type ExpansionCandidate = {
  id: string;
  title: string;
  score: number;
  expectedChars: number;
};

export function buildRecallBudget(hint?: RecallBudgetHint): RecallBudget {
  return {
    maxItems: Math.max(1, Math.min(hint?.maxItems ?? env.HMRS_RECALL_MAX_ITEMS, env.HMRS_RECALL_MAX_ITEMS)),
    maxChars: Math.max(2_000, Math.min(hint?.maxChars ?? env.HMRS_RECALL_MAX_CHARS, env.HMRS_RECALL_MAX_CHARS)),
    priority: hint?.priority ?? "balanced",
  };
}

export function trimByBudget(candidates: ExpansionCandidate[], budget: RecallBudget): ExpansionCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: ExpansionCandidate[] = [];
  let usedChars = 0;
  for (const candidate of sorted) {
    if (selected.length >= budget.maxItems) break;
    if (usedChars + candidate.expectedChars > budget.maxChars) continue;
    selected.push(candidate);
    usedChars += candidate.expectedChars;
  }
  return selected;
}
