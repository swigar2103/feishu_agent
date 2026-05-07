import type { Draft } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import type { HmrsRepositories } from "../repo/interfaces.js";
import { logger } from "../../../shared/logger.js";
import {
  type L1CatalogObject,
  type L2IndexObject,
  type L3DetailPointerObject,
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
  L3DetailPointerObjectSchema,
} from "../model/layerSchemas.js";

export class MemoryWritebackService {
  constructor(private readonly repos: HmrsRepositories) {}

  private qualityFromDraft(draft: Draft): number {
    const sectionCoverage = Math.min(1, draft.sections.length / 6);
    const visualCoverage = Math.min(
      1,
      (draft.chartSlots.length + draft.timelineSlots.length + draft.ganttSlots.length) / 4,
    );
    return Number((sectionCoverage * 0.6 + visualCoverage * 0.4).toFixed(3));
  }

  async writeFromDraft(input: {
    request: UserRequest;
    draft: Draft;
    signals: Array<{ signalType: string; sectionHeading?: string }>;
  }): Promise<void> {
    const owner = input.request.userId;
    const projectTag = input.request.industry ?? input.request.reportType ?? "default";

    const qualityScore = this.qualityFromDraft(input.draft);
    const uniqueSignals = Array.from(
      new Map(
        input.signals.map((signal) => [
          `${signal.signalType}:${signal.sectionHeading ?? "unknown"}`,
          signal,
        ]),
      ).values(),
    );
    const l1Patch: L1CatalogObject = L1CatalogObjectSchema.parse({
      id: `l1_style_${owner}`,
      type: "StyleIdentitySummary",
      layer: "L1",
      wingId: "people_wing",
      roomId: "self_room",
      drawerId: "style_drawer",
      owner,
      projectTag,
      timeRange: { end: new Date().toISOString() },
      keywords: input.draft.sections.map((s) => s.heading).slice(0, 12),
      qualityScore,
      sourceRef: { sourceType: "unknown" },
      title: "风格身份摘要",
      summary: input.draft.summary.slice(0, 500),
    });

    const l2Patches: L2IndexObject[] = input.draft.sections.slice(0, 10).map((section, idx) =>
      L2IndexObjectSchema.parse({
        id: `l2_template_pref_${owner}_${idx + 1}`,
        type: "TemplateStructureIndex",
        layer: "L2",
        wingId: "templates_wing",
        roomId: "weekly_report_room",
        drawerId: "structure_drawer",
        owner,
        parentId: l1Patch.id,
        projectTag,
        timeRange: { end: new Date().toISOString() },
        keywords: [section.heading, ...section.content.split(/[，。,\s]/).filter((t) => t.length >= 2).slice(0, 8)],
        qualityScore,
        sourceRef: { sourceType: "unknown" },
        title: section.heading,
        structureSummary: section.content.slice(0, 600),
      }),
    );

    const l3Patches: L3DetailPointerObject[] = uniqueSignals.slice(0, 8).map((signal, idx) =>
      L3DetailPointerObjectSchema.parse({
        id: `l3_edit_signal_${owner}_${idx + 1}`,
        type: "ExemplarSnippetPointer",
        layer: "L3",
        wingId: "people_wing",
        roomId: "self_room",
        drawerId: "exemplar_drawer",
        owner,
        parentId: l2Patches[idx % Math.max(1, l2Patches.length)]?.id,
        projectTag,
        timeRange: { end: new Date().toISOString() },
        keywords: [signal.signalType, signal.sectionHeading ?? "unknown"],
        qualityScore,
        sourceRef: { sourceType: "unknown" },
        pointerType: "unknown",
        pointerSummary: `${signal.signalType}:${signal.sectionHeading ?? "未指定章节"}`,
      }),
    );

    await this.repos.catalog.upsert([l1Patch]);
    await this.repos.index.upsert(l2Patches);
    const telemetry = {
      reportType: input.request.reportType,
      selectedSkillId: undefined,
      workflowTemplateId: undefined,
      sectionCount: input.draft.sections.length,
      signalCount: input.signals.length,
      dedupedSignalCount: uniqueSignals.length,
      chartSlotCount: input.draft.chartSlots.length,
      timelineSlotCount: input.draft.timelineSlots.length,
      ganttSlotCount: input.draft.ganttSlots.length,
    } as const;
    await this.repos.writeback.write({
      owner,
      l1Patches: [l1Patch],
      l2Patches,
      l3Patches,
      telemetry,
    });
    logger.info("[hmrs-writeback-telemetry] writeback persisted", {
      owner,
      l1Count: 1,
      l2Count: l2Patches.length,
      l3Count: l3Patches.length,
      telemetry,
    });
  }
}
