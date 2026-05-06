import type { ResourceSummary } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import {
  type L1CatalogObject,
  type L2IndexObject,
  type SourceRef,
  L1CatalogObjectSchema,
  L2IndexObjectSchema,
} from "./layerSchemas.js";

function inferSourceRef(resource: ResourceSummary): SourceRef {
  if (resource.link?.includes("/docx/")) {
    return {
      sourceType: "doc",
      url: resource.link,
      docToken: resource.link.split("/").pop(),
    };
  }
  if (resource.resourceType === "table_summary") {
    return {
      sourceType: "table",
      url: resource.link,
    };
  }
  if (resource.resourceType === "message_thread_summary" || resource.resourceType === "contact_summary") {
    return {
      sourceType: "chat",
      url: resource.link,
    };
  }
  return {
    sourceType: "unknown",
    url: resource.link,
  };
}

function normalizeKeywords(resource: ResourceSummary, request: UserRequest): string[] {
  return Array.from(
    new Set(
      [
        ...resource.keywords,
        ...resource.tags,
        request.reportType ?? "",
        request.industry ?? "",
      ].filter((item) => item.trim().length > 0),
    ),
  ).slice(0, 20);
}

export function toL1CatalogObject(resource: ResourceSummary, request: UserRequest): L1CatalogObject {
  return L1CatalogObjectSchema.parse({
    id: `l1_${resource.resourceId}`,
    type: resource.resourceType,
    layer: "L1",
    owner: request.userId,
    projectTag: resource.project || request.industry || "default",
    timeRange: { end: resource.updatedAt },
    keywords: normalizeKeywords(resource, request),
    qualityScore: resource.score ?? 0.45,
    sourceRef: inferSourceRef(resource),
    title: resource.title,
    summary: resource.summary,
  });
}

export function toL2IndexObject(resource: ResourceSummary, request: UserRequest): L2IndexObject {
  const structureSummary = `${resource.title} ${resource.summary}`.slice(0, 2400);
  return L2IndexObjectSchema.parse({
    id: `l2_${resource.resourceId}`,
    type: resource.resourceType,
    layer: "L2",
    owner: request.userId,
    parentId: `l1_${resource.resourceId}`,
    projectTag: resource.project || request.industry || "default",
    timeRange: { end: resource.updatedAt },
    keywords: normalizeKeywords(resource, request),
    qualityScore: Math.min(1, (resource.score ?? 0.45) + 0.05),
    sourceRef: inferSourceRef(resource),
    title: resource.title,
    structureSummary,
  });
}
