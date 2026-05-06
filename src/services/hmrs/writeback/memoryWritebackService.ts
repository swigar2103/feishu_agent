import type { Draft } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import type { HmrsRepositories } from "../repo/interfaces.js";
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

  async writeFromDraft(input: {
    request: UserRequest;
    draft: Draft;
    signals: Array<{ signalType: string; sectionHeading?: string }>;
  }): Promise<void> {
    const owner = input.request.userId;
    const projectTag = input.request.industry ?? input.request.reportType ?? "default";

    const l1Patch: L1CatalogObject = L1CatalogObjectSchema.parse({
      id: `l1_style_${owner}`,
      type: "StyleIdentitySummary",
      layer: "L1",
      owner,
      projectTag,
      timeRange: { end: new Date().toISOString() },
      keywords: input.draft.sections.map((s) => s.heading).slice(0, 12),
      qualityScore: 0.72,
      sourceRef: { sourceType: "unknown" },
      title: "风格身份摘要",
      summary: input.draft.summary.slice(0, 500),
    });

    const l2Patches: L2IndexObject[] = input.draft.sections.slice(0, 10).map((section, idx) =>
      L2IndexObjectSchema.parse({
        id: `l2_template_pref_${owner}_${idx + 1}`,
        type: "TemplateStructureIndex",
        layer: "L2",
        owner,
        parentId: l1Patch.id,
        projectTag,
        timeRange: { end: new Date().toISOString() },
        keywords: [section.heading, ...section.content.split(/[，。,\s]/).filter((t) => t.length >= 2).slice(0, 8)],
        qualityScore: 0.68,
        sourceRef: { sourceType: "unknown" },
        title: section.heading,
        structureSummary: section.content.slice(0, 600),
      }),
    );

    const l3Patches: L3DetailPointerObject[] = input.signals.slice(0, 8).map((signal, idx) =>
      L3DetailPointerObjectSchema.parse({
        id: `l3_edit_signal_${owner}_${idx + 1}`,
        type: "ExemplarSnippetPointer",
        layer: "L3",
        owner,
        parentId: l2Patches[idx % Math.max(1, l2Patches.length)]?.id,
        projectTag,
        timeRange: { end: new Date().toISOString() },
        keywords: [signal.signalType, signal.sectionHeading ?? "unknown"],
        qualityScore: 0.55,
        sourceRef: { sourceType: "unknown" },
        pointerType: "unknown",
        pointerSummary: `${signal.signalType}:${signal.sectionHeading ?? "未指定章节"}`,
      }),
    );

    await this.repos.catalog.upsert([l1Patch]);
    await this.repos.index.upsert(l2Patches);
    await this.repos.writeback.write({
      owner,
      l1Patches: [l1Patch],
      l2Patches,
      l3Patches,
    });
  }
}
