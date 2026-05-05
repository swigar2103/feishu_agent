import { getFeishuMvpConfig } from "../../integrations/feishu/feishuConfig.js";
import { listAllDocumentBlocks, replaceBlockWithPlainText } from "../../integrations/feishu/docxBlocks.js";
import { feishuHttpFetch } from "../../integrations/feishu/httpFetch.js";
import { getTenantAccessToken } from "../../integrations/feishu/token.js";
import { parseJsonFromMd } from "../retrieval/mdParser.js";
import { ResourcePoolStore } from "../../storage/resourcePoolStore.js";
import type {
  AddCommentInput,
  CreateDocumentInput,
  CreateSlidesInput,
  FeishuToolGatewayApi,
  GatewayComment,
  GatewayDocument,
  GatewayMessage,
  GatewaySlide,
  GatewayUser,
  GatewayWhiteboard,
  ListMessagesInput,
  SendMessageInput,
  UpdateDocumentInput,
  UpdateWhiteboardInput,
} from "./types.js";

type AssetRecord = {
  sourceId: string;
  sourceType: "message" | "doc" | "table";
  content: string;
};

type UserRecord = {
  id: string;
  name: string;
  role?: string;
  department?: string;
};

export class FeishuOpenApiAdapter implements FeishuToolGatewayApi {
  private readonly poolStore = new ResourcePoolStore();

  private getAssets(): AssetRecord[] {
    try {
      return parseJsonFromMd<AssetRecord[]>("src/data/assets.md");
    } catch {
      return [];
    }
  }

  private getUsersFromAssets(): UserRecord[] {
    const resources = this.poolStore.loadAll();
    const users = resources
      .filter((item) => item.resourceType === "contact_summary")
      .map((item) => ({
        id: item.resourceId,
        name: item.title,
        role: item.tags.find((tag) => tag !== "contact"),
      }));
    return users;
  }

  async searchDocuments(query: string): Promise<GatewayDocument[]> {
    const text = query.toLowerCase();
    const fromPool = this.poolStore
      .loadAll()
      .filter((item) => item.resourceType === "doc_summary" || item.resourceType === "project_memory")
      .filter(
        (item) =>
          item.title.toLowerCase().includes(text) ||
          item.summary.toLowerCase().includes(text) ||
          item.tags.some((tag) => tag.toLowerCase().includes(text)),
      )
      .slice(0, 8)
      .map((item) => ({
        id: item.resourceId,
        title: item.title,
        summary: item.summary,
        url: item.link,
        source: "openapi" as const,
      }));

    if (fromPool.length > 0) return fromPool;

    return this.getAssets()
      .filter((item) => item.sourceType === "doc")
      .filter((item) => item.content.toLowerCase().includes(text))
      .slice(0, 8)
      .map((item) => ({
        id: item.sourceId,
        title: item.sourceId,
        summary: item.content,
        source: "openapi" as const,
      }));
  }

  async listDocuments(query?: string): Promise<GatewayDocument[]> {
    const docs = this.poolStore
      .loadAll()
      .filter((item) => item.resourceType === "doc_summary" || item.resourceType === "project_memory")
      .map((item) => ({
        id: item.resourceId,
        title: item.title,
        summary: item.summary,
        url: item.link,
        source: "openapi" as const,
      }));
    if (!query) return docs.slice(0, 20);
    const text = query.toLowerCase();
    return docs.filter(
      (item) => item.title.toLowerCase().includes(text) || (item.summary ?? "").toLowerCase().includes(text),
    );
  }

  async viewDocument(documentId: string): Promise<GatewayDocument | null> {
    const poolHit = this.poolStore.loadAll().find((item) => item.resourceId === documentId);
    if (poolHit) {
      return {
        id: poolHit.resourceId,
        title: poolHit.title,
        summary: poolHit.summary,
        content: poolHit.summary,
        url: poolHit.link,
        source: "openapi",
      };
    }

    const asset = this.getAssets().find((item) => item.sourceId === documentId);
    if (!asset) return null;
    return {
      id: asset.sourceId,
      title: asset.sourceId,
      summary: asset.content.slice(0, 200),
      content: asset.content,
      source: "openapi",
    };
  }

  async getFileContent(fileToken: string): Promise<string> {
    const doc = await this.viewDocument(fileToken);
    return doc?.content ?? "";
  }

  async createDocument(input: CreateDocumentInput): Promise<GatewayDocument> {
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) {
      const id = `openapi_doc_${Date.now()}`;
      return {
        id,
        title: input.title,
        summary: input.content?.slice(0, 200),
        content: input.content,
        url: `https://mock.feishu.local/docx/${id}`,
        source: "openapi",
      };
    }

    const access = await getTenantAccessToken(c);
    const url = `${c.baseUrl}/open-apis/docx/v1/documents`;
    const res = await feishuHttpFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        folder_token: c.targetFolderToken || undefined,
        title: input.title,
      }),
    });
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      data?: { document?: { document_id?: string } };
    };
    if (!res.ok || data.code !== 0 || !data.data?.document?.document_id) {
      throw new Error(`OpenAPI createDocument 失败: ${data.msg ?? res.status}`);
    }
    const documentId = data.data.document.document_id;
    if (input.content?.trim()) {
      await this.updateDocument({
        documentId,
        content: input.content,
      });
    }
    return {
      id: documentId,
      title: input.title,
      summary: input.content?.slice(0, 200),
      content: input.content,
      url: `https://www.feishu.cn/docx/${documentId}`,
      source: "openapi",
    };
  }

  async updateDocument(input: UpdateDocumentInput): Promise<boolean> {
    const c = getFeishuMvpConfig();
    if (!c.appId || !c.appSecret) return false;
    const blocks = await listAllDocumentBlocks(c, input.documentId);
    const textOrHeading = blocks.find(
      (item) =>
        item.block_type === 2 ||
        (typeof item.block_type === "number" && item.block_type >= 3 && item.block_type <= 11),
    );
    if (!textOrHeading?.block_id) return false;
    await replaceBlockWithPlainText(c, input.documentId, textOrHeading.block_id, input.content);
    return true;
  }

  async getComments(_documentId: string): Promise<GatewayComment[]> {
    return [];
  }

  async addComment(_input: AddCommentInput): Promise<boolean> {
    return false;
  }

  async searchUsers(query: string): Promise<GatewayUser[]> {
    const text = query.toLowerCase();
    return this.getUsersFromAssets()
      .filter((user) => user.name.toLowerCase().includes(text) || (user.role ?? "").toLowerCase().includes(text))
      .slice(0, 8)
      .map((item) => ({
        id: item.id,
        name: item.name,
        department: item.department,
        role: item.role,
        source: "openapi",
      }));
  }

  async getUserInfo(userId: string): Promise<GatewayUser | null> {
    const user = this.getUsersFromAssets().find((item) => item.id === userId);
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      department: user.department,
      role: user.role,
      source: "openapi",
    };
  }

  async createSlides(input: CreateSlidesInput): Promise<GatewaySlide> {
    return {
      presentationId: `openapi_slides_${Date.now()}`,
      title: input.title,
      url: `https://mock.feishu.local/slides/${Date.now()}`,
      source: "openapi",
    };
  }

  async queryWhiteboard(token: string): Promise<GatewayWhiteboard | null> {
    return {
      token,
      title: `whiteboard-${token}`,
      content: "",
      previewUrl: `https://mock.feishu.local/whiteboard/${token}`,
      source: "openapi",
    };
  }

  async updateWhiteboard(_input: UpdateWhiteboardInput): Promise<boolean> {
    return false;
  }

  async sendMessage(_input: SendMessageInput): Promise<boolean> {
    return false;
  }

  async listMessages(_input: ListMessagesInput): Promise<GatewayMessage[]> {
    return [];
  }
}

