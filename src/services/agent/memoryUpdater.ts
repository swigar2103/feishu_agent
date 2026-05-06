import { MemoryUpdateSchema, type Draft, type MemoryUpdate } from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { MemoryStore } from "../../storage/memoryStore.js";
import { getMemoryFacade } from "../hmrs/facade/memoryFacade.js";

export async function updateMemoryFromRun(input: {
  request: UserRequest;
  draft: Draft;
}): Promise<MemoryUpdate> {
  const learnedPreferences: string[] = [];
  const editSignals: MemoryUpdate["editSignals"] = [];
  if (input.draft.summary.length < 120) {
    learnedPreferences.push("偏好短摘要");
  }
  if (input.draft.sections.some((section) => section.heading.includes("行动"))) {
    learnedPreferences.push("偏好行动导向结构");
  }
  if (input.draft.timelineSlots.length > 0 || input.draft.ganttSlots.length > 0) {
    learnedPreferences.push("偏好结构化计划版式");
    editSignals.push({
      signalType: "template_preference",
      sectionHeading: input.draft.timelineSlots[0]?.title ?? input.draft.ganttSlots[0]?.task,
    });
  }

  const memoryStore = new MemoryStore();
  memoryStore.upsert(input.request.userId, {
    preferredTone: input.draft.summary.length < 120 ? "简洁结论先行" : undefined,
    styleNotes: learnedPreferences,
    commonTerms: input.draft.sections
      .flatMap((section) => section.content.split(/[，。,\s]/))
      .filter((token) => token.length >= 4)
      .slice(0, 8),
  });

  const parsed = MemoryUpdateSchema.parse({
    updated: learnedPreferences.length > 0,
    learnedPreferences,
    editSignals,
  });
  const facade = getMemoryFacade();
  await facade.writeback({
    request: input.request,
    draft: input.draft,
    memoryUpdate: parsed,
  });
  return parsed;
}
