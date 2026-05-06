import type { CandidateResourceList, DetailedContext } from "../../../schemas/agentContracts.js";
import { DetailedContextSchema } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import { toolGateway } from "../../toolGateway/gateway.js";
import { hasValidUserOAuth } from "../../../storage/userOAuthStore.js";

type ExpandedItem = {
  l2Id: string;
  resourceId: string;
  title: string;
  summary: string;
};

function toFact(sourceId: string, fact: string, evidence?: string) {
  return {
    sourceId,
    fact,
    ...(evidence ? { evidence } : {}),
  };
}

function fromL2ToResourceId(l2Id: string): string {
  return l2Id.replace(/^l2_/, "");
}

export async function fetchDetailByExpansion(input: {
  request: UserRequest;
  expandedL2Ids: string[];
  screened: CandidateResourceList;
}): Promise<DetailedContext> {
  const byId = new Map(input.screened.candidates.map((item) => [item.resourceId, item]));
  const expanded: ExpandedItem[] = input.expandedL2Ids
    .map((l2Id) => {
      const resourceId = fromL2ToResourceId(l2Id);
      const candidate = byId.get(resourceId);
      if (!candidate) return null;
      return {
        l2Id,
        resourceId,
        title: candidate.title,
        summary: candidate.summary,
      };
    })
    .filter((item): item is ExpandedItem => item !== null);

  const context =
    input.request.userId && hasValidUserOAuth(input.request.userId)
      ? { userId: input.request.userId, preferUserScope: true as const }
      : undefined;

  const facts: DetailedContext["facts"] = [];
  const sourceDetails: DetailedContext["sourceDetails"] = [];

  for (const item of expanded) {
    const rawDocId = item.resourceId.startsWith("ext_doc_")
      ? item.resourceId.replace("ext_doc_", "")
      : item.resourceId;
    const viewed = await toolGateway.viewDocument(rawDocId, context).catch(() => null);
    const content = viewed?.content?.trim();
    if (content) {
      const clipped = content.slice(0, 12_000);
      facts.push(
        toFact(item.resourceId, clipped, "HMRS L3 按需展开正文摘录"),
      );
      sourceDetails.push({
        resourceId: item.resourceId,
        detail: content,
      });
      continue;
    }
    facts.push(
      toFact(item.resourceId, item.summary, "HMRS L3 展开失败，回退摘要"),
    );
    sourceDetails.push({
      resourceId: item.resourceId,
      detail: `${item.title}\n${item.summary}`,
    });
  }

  return DetailedContextSchema.parse({
    facts,
    sourceDetails,
  });
}
