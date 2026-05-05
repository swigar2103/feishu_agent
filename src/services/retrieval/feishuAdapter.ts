import { parseJsonFromMd } from "./mdParser.js";
import type { RetrievalContext } from "../../schemas/index.js";

type AssetType = RetrievalContext["projectContext"][0];

/**
 * @deprecated 仅用于历史兼容，主流程请改走 Tool Gateway。
 */
export class FeishuMockAdapter {
  private assets: AssetType[] = [];

  constructor() {
    this.assets = parseJsonFromMd<AssetType[]>('src/data/assets.md');
  }

  async searchEverything(query: string): Promise<AssetType[]> {
    await new Promise(resolve => setTimeout(resolve, 300));
    const results = this.assets.filter(asset =>
      asset.content.toLowerCase().includes(query.toLowerCase()) ||
      query.toLowerCase().includes("报告")
    );
    return results.length > 0 ? results : this.assets.slice(0, 2);
  }
}