import { FinalDeliverableSchema, type Draft, type FinalDeliverable, type IntentResult } from "../../schemas/agentContracts.js";
import type { UserRequest } from "../../schemas/index.js";
import { publishOutputs } from "../output/publisher.js";
import { hasValidUserOAuth } from "../../storage/userOAuthStore.js";
import type { RenderedArtifact } from "../render/artifactRenderer.js";

export async function generateFinalOutput(input: {
  request: UserRequest;
  intent: IntentResult;
  draft: Draft;
  renderedArtifacts?: RenderedArtifact[];
}): Promise<FinalDeliverable> {
  const outputKind = input.intent.outputKind;
  const preferUserScope = hasValidUserOAuth(input.request.userId);
  const publishedArtifacts = await publishOutputs({
    draft: input.draft,
    outputTargets: input.request.outputTargets,
    sessionId: input.request.sessionId,
    userId: input.request.userId,
    preferUserScope,
    renderedArtifacts: input.renderedArtifacts,
  });

  return FinalDeliverableSchema.parse({
    outputKind,
    title: input.draft.title,
    content: input.draft,
    outputTargets: input.request.outputTargets,
    publishedArtifacts,
  });
}
