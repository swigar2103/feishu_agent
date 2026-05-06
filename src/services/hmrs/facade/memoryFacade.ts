import type { CandidateResourceList, ExecutionPlan, ResourceSummary } from "../../../schemas/agentContracts.js";
import type { UserRequest } from "../../../schemas/index.js";
import { toL1CatalogObject, toL2IndexObject } from "../model/memoryObjects.js";
import type { L1CatalogObject, L2IndexObject } from "../model/layerSchemas.js";
import type { HmrsRepositories } from "../repo/interfaces.js";
import { createFileHmrsRepositories } from "../repo/file/index.js";
import { SummaryQueryService } from "../query/summaryQueryService.js";
import { buildExpansionDecision, type ExpansionDecision } from "../expand/expansionPlanner.js";
import { fetchDetailByExpansion } from "../expand/detailRetrievalService.js";
import { MemoryWritebackService } from "../writeback/memoryWritebackService.js";
import type { Draft, MemoryUpdate } from "../../../schemas/agentContracts.js";
import { HmrsRefreshService } from "../hmrsRefreshService.js";

export class MemoryFacade {
  private readonly queryService: SummaryQueryService;
  private readonly writebackService: MemoryWritebackService;
  private readonly refreshService: HmrsRefreshService;

  constructor(private readonly repos: HmrsRepositories) {
    this.queryService = new SummaryQueryService(repos);
    this.writebackService = new MemoryWritebackService(repos);
    this.refreshService = new HmrsRefreshService();
  }

  async ingestResourcePool(request: UserRequest, resourcePool: ResourceSummary[]): Promise<void> {
    const l1 = resourcePool.map((item) => toL1CatalogObject(item, request));
    const l2 = resourcePool.map((item) => toL2IndexObject(item, request));
    await this.repos.catalog.upsert(l1);
    await this.repos.index.upsert(l2);
  }

  async queryL1(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    return this.queryService.queryL1(input);
  }

  async queryWingSummaries(input: {
    owner: string;
    keyword: string;
    wings?: string[];
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    return this.queryService.queryWingSummaries(input);
  }

  async queryL2(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
    ids?: string[];
  }): Promise<L2IndexObject[]> {
    return this.queryService.queryL2(input);
  }

  async queryRoomIndexes(input: {
    owner: string;
    keyword: string;
    rooms?: string[];
    limit?: number;
  }): Promise<L2IndexObject[]> {
    return this.queryService.queryRoomIndexes(input);
  }

  async refreshManagedFolders(input: { userId: string; nickname?: string }): Promise<{
    rootFolderToken: string;
    managedFolderCount: number;
    ingestedDocCount: number;
  }> {
    return this.refreshService.refreshForUser(input);
  }

  async planExpansion(input: {
    plan: ExecutionPlan;
    l1: L1CatalogObject[];
    l2: L2IndexObject[];
  }): Promise<ExpansionDecision> {
    return buildExpansionDecision({
      plan: input.plan,
      l1: input.l1,
      l2: input.l2,
      budgetHint: input.plan.recallBudgetHint,
    });
  }

  async retrieveDetails(input: {
    request: UserRequest;
    expansion: ExpansionDecision;
    screened: CandidateResourceList;
  }) {
    return fetchDetailByExpansion({
      request: input.request,
      expandedL2Ids: input.expansion.finalResourceIds,
      screened: input.screened,
    });
  }

  async writeback(input: { request: UserRequest; draft: Draft; memoryUpdate: MemoryUpdate }): Promise<void> {
    await this.writebackService.writeFromDraft({
      request: input.request,
      draft: input.draft,
      signals: input.memoryUpdate.editSignals,
    });
  }
}

let singleton: MemoryFacade | null = null;

export function getMemoryFacade(): MemoryFacade {
  if (!singleton) {
    singleton = new MemoryFacade(createFileHmrsRepositories());
  }
  return singleton;
}
