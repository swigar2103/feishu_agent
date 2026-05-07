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

/** 命中任一即视为草稿质量不达标，禁止写回（避免污染 HMRS 形成回路） */
const POLLUTION_PATTERN =
  /(文档|document)\s*ID|缺失|为空|无法获取|无法加载|无法访问|占位|todo|fallback|VALIDATION:1002/i;
const WRITER_VALIDATION_FAILURE_HINT = "Writer JSON 生成未通过校验";

export type DraftQualityVerdict = {
  pass: boolean;
  reasons: string[];
};

export function evaluateDraftQuality(input: {
  draft: Draft;
  expectedSectionCount?: number;
}): DraftQualityVerdict {
  const reasons: string[] = [];
  const draft = input.draft;
  const summary = (draft.summary ?? "").trim();
  if (summary.length < 80) reasons.push(`summary_too_short(${summary.length})`);
  if (POLLUTION_PATTERN.test(summary)) reasons.push("summary_contains_polluted_phrase");

  const expected = input.expectedSectionCount ?? draft.sections.length;
  if (expected > 0 && draft.sections.length < Math.ceil(expected * 0.6)) {
    reasons.push(`sections_too_few(${draft.sections.length}/${expected})`);
  }

  for (const section of draft.sections) {
    const content = (section.content ?? "").trim();
    if (!content) {
      reasons.push(`section_empty:${section.heading}`);
      continue;
    }
    if (POLLUTION_PATTERN.test(content)) {
      reasons.push(`section_polluted:${section.heading}`);
    }
    if (content.length < 30) {
      reasons.push(`section_too_short:${section.heading}(${content.length})`);
    }
  }

  if ((draft.openQuestions ?? []).some((q) => q.includes(WRITER_VALIDATION_FAILURE_HINT))) {
    reasons.push("writer_schema_validation_failed");
  }

  return { pass: reasons.length === 0, reasons };
}

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

    const verdict = evaluateDraftQuality({ draft: input.draft });
    if (!verdict.pass) {
      logger.warn("[hmrs-writeback] draft quality gate rejected, skipping writeback to avoid HMRS pollution", {
        owner,
        sessionId: input.request.sessionId,
        sectionCount: input.draft.sections.length,
        summaryLen: input.draft.summary.length,
        reasons: verdict.reasons.slice(0, 8),
      });
      return;
    }

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
