export type GatewayDocument = {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  url?: string;
  source?: "mcp" | "openapi" | "lark_cli";
};

export type GatewayUser = {
  id: string;
  name: string;
  department?: string;
  role?: string;
  source?: "mcp" | "openapi" | "lark_cli";
};

export type GatewayComment = {
  id: string;
  author?: string;
  content: string;
  createdAt?: string;
  source?: "mcp" | "openapi" | "lark_cli";
};

export type CreateDocumentInput = {
  title: string;
  content?: string;
};

export type UpdateDocumentInput = {
  documentId: string;
  content: string;
};

export type AddCommentInput = {
  documentId: string;
  content: string;
};

export type CreateSlidesInput = {
  title: string;
  outline: string;
};

export type GatewaySlides = {
  id: string;
  title: string;
  outline?: string;
  url?: string;
  source?: "mcp" | "openapi" | "lark_cli";
};

export interface FeishuToolGatewayApi {
  searchDocuments(query: string): Promise<GatewayDocument[]>;
  listDocuments(query?: string): Promise<GatewayDocument[]>;
  viewDocument(documentId: string): Promise<GatewayDocument | null>;
  getFileContent(fileToken: string): Promise<string>;
  createDocument(input: CreateDocumentInput): Promise<GatewayDocument>;
  updateDocument(input: UpdateDocumentInput): Promise<boolean>;
  getComments(documentId: string): Promise<GatewayComment[]>;
  addComment(input: AddCommentInput): Promise<boolean>;
  searchUsers(query: string): Promise<GatewayUser[]>;
  getUserInfo(userId: string): Promise<GatewayUser | null>;
  createSlides(input: CreateSlidesInput): Promise<GatewaySlides>;
}
