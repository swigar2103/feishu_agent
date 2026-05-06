import type { L1CatalogObject, L2IndexObject } from "../model/layerSchemas.js";
import type { HmrsRepositories } from "../repo/interfaces.js";

export class SummaryQueryService {
  constructor(private readonly repos: HmrsRepositories) {}

  async queryL1(input: {
    owner: string;
    keyword: string;
    projectTag?: string;
    limit?: number;
  }): Promise<L1CatalogObject[]> {
    return this.repos.catalog.query({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      limit: input.limit ?? 8,
    });
  }

  async queryL2(input: {
    owner: string;
    keyword: string;
    limit?: number;
    ids?: string[];
    projectTag?: string;
  }): Promise<L2IndexObject[]> {
    return this.repos.index.query({
      owner: input.owner,
      keyword: input.keyword,
      projectTag: input.projectTag,
      ids: input.ids,
      limit: input.limit ?? 12,
    });
  }
}
