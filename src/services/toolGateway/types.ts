export type GatewayDocument = {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  url?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type GatewayUser = {
  id: string;
  name: string;
  department?: string;
  role?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type GatewayComment = {
  id: string;
  author?: string;
  content: string;
  createdAt?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type GatewayMessage = {
  id: string;
  chatId?: string;
  sender?: string;
  content: string;
  createdAt?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type GatewaySlide = {
  presentationId: string;
  title?: string;
  url?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type GatewayWhiteboard = {
  token: string;
  title?: string;
  content?: string;
  previewUrl?: string;
  source?: "mcp" | "lark_cli" | "openapi";
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
  outline?: string;
};

export type UpdateWhiteboardInput = {
  token: string;
  content: string;
  syntax?: "mermaid" | "plantuml" | "dsl";
};

export type SendMessageInput = {
  chatId?: string;
  userId?: string;
  content: string;
  msgType?: "text" | "md";
};

export type ListMessagesInput = {
  chatId?: string;
  userId?: string;
  limit?: number;
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
  createSlides(input: CreateSlidesInput): Promise<GatewaySlide>;
  queryWhiteboard(token: string): Promise<GatewayWhiteboard | null>;
  updateWhiteboard(input: UpdateWhiteboardInput): Promise<boolean>;
  sendMessage(input: SendMessageInput): Promise<boolean>;
  listMessages(input: ListMessagesInput): Promise<GatewayMessage[]>;
}
