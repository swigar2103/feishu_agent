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

export type GatewayRequestContext = {
  userId?: string;
  preferUserScope?: boolean;
};

export type GatewayDriveItem = {
  token: string;
  name: string;
  type: string;
  url?: string;
  modifiedTime?: number;
};

export type GatewayRootFolderMeta = {
  token: string;
  url?: string;
  name?: string;
};

export type GatewayFolderMeta = {
  token: string;
  url?: string;
  name?: string;
};

export type GatewayDriveTaskStatus = {
  ticket: string;
  status: "pending" | "success" | "failed";
  progress?: number;
  errorMessage?: string;
  resultFileToken?: string;
  resultUrl?: string;
};

export type CreateDocumentInput = {
  title: string;
  content?: string;
  userId?: string;
  preferUserScope?: boolean;
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

export type UploadImageMediaInput = {
  buffer: Uint8Array;
  fileName: string;
  parent?: { type: "docx_image"; documentId: string } | { type: "drive"; folderToken?: string };
  mimeType?: string;
};

export type UploadImageMediaResult = {
  mediaToken: string;
  url?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type DocxImageBlockInsertInput = {
  documentId: string;
  parentBlockId: string;
  /** 在父块 children 中的插入位置；缺省 = 末尾 */
  index?: number;
  mediaToken: string;
  caption?: string;
};

export type DocxEmbedBlockInsertInput = {
  documentId: string;
  parentBlockId: string;
  index?: number;
  embedKind: "whiteboard" | "sheet" | "bitable";
  /** 被引用对象的 file token */
  refToken: string;
  caption?: string;
};

export type DocxBlockInsertResult = {
  blockId?: string;
  source?: "mcp" | "lark_cli" | "openapi";
  ok: boolean;
  warning?: string;
};

export type SheetCreateInput = {
  title: string;
  parentFolderToken?: string;
};

export type SheetCreateResult = {
  spreadsheetToken: string;
  sheetId?: string;
  url?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type SheetWriteInput = {
  spreadsheetToken: string;
  sheetId: string;
  /** 形如 A1:F20，必须含 sheetId 引用，由 adapter 内部组合 */
  range: string;
  values: Array<Array<string | number | boolean | null>>;
};

export type SheetChartInput = {
  spreadsheetToken: string;
  sheetId: string;
  range: string;
  chartType: "line" | "bar" | "pie" | "table";
  title?: string;
};

export type SheetChartResult = {
  chartToken: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export type WhiteboardCreateInput = {
  title: string;
  /** 仅支持 plantuml/mermaid 字符串，由 adapter 决定如何渲染 */
  syntax: "plantuml" | "mermaid";
  body: string;
  parentFolderToken?: string;
};

export type WhiteboardCreateResult = {
  whiteboardToken: string;
  url?: string;
  source?: "mcp" | "lark_cli" | "openapi";
};

export interface FeishuToolGatewayApi {
  searchDocuments(query: string, context?: GatewayRequestContext): Promise<GatewayDocument[]>;
  listDocuments(query?: string, context?: GatewayRequestContext): Promise<GatewayDocument[]>;
  viewDocument(documentId: string, context?: GatewayRequestContext): Promise<GatewayDocument | null>;
  getFileContent(fileToken: string, context?: GatewayRequestContext): Promise<string>;
  createDocument(input: CreateDocumentInput, context?: GatewayRequestContext): Promise<GatewayDocument>;
  updateDocument(input: UpdateDocumentInput, context?: GatewayRequestContext): Promise<boolean>;
  getComments(documentId: string, context?: GatewayRequestContext): Promise<GatewayComment[]>;
  addComment(input: AddCommentInput, context?: GatewayRequestContext): Promise<boolean>;
  searchUsers(query: string, context?: GatewayRequestContext): Promise<GatewayUser[]>;
  getUserInfo(userId: string, context?: GatewayRequestContext): Promise<GatewayUser | null>;
  createSlides(input: CreateSlidesInput): Promise<GatewaySlide>;
  queryWhiteboard(token: string): Promise<GatewayWhiteboard | null>;
  updateWhiteboard(input: UpdateWhiteboardInput): Promise<boolean>;
  sendMessage(input: SendMessageInput): Promise<boolean>;
  listMessages(input: ListMessagesInput): Promise<GatewayMessage[]>;
  getRootFolderMeta(context?: GatewayRequestContext): Promise<GatewayRootFolderMeta>;
  getFolderMeta(folderToken: string, context?: GatewayRequestContext): Promise<GatewayFolderMeta>;
  listFolderItems(folderToken: string, context?: GatewayRequestContext): Promise<GatewayDriveItem[]>;
  createFolder(
    input: { parentFolderToken: string; folderName: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayFolderMeta>;
  moveFile(
    input: { fileToken: string; targetFolderToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null>;
  copyFile(
    input: { fileToken: string; targetFolderToken: string; fileName?: string; copyAsDocx?: boolean },
    context?: GatewayRequestContext,
  ): Promise<{ fileToken?: string; url?: string; task?: GatewayDriveTaskStatus | null }>;
  deleteFile(
    input: { fileToken: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus | null>;
  checkTask(
    input: { ticket: string },
    context?: GatewayRequestContext,
  ): Promise<GatewayDriveTaskStatus>;
  uploadImageMedia(
    input: UploadImageMediaInput,
    context?: GatewayRequestContext,
  ): Promise<UploadImageMediaResult>;
  insertDocxImageBlock(
    input: DocxImageBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult>;
  insertDocxEmbedBlock(
    input: DocxEmbedBlockInsertInput,
    context?: GatewayRequestContext,
  ): Promise<DocxBlockInsertResult>;
  createSheet(
    input: SheetCreateInput,
    context?: GatewayRequestContext,
  ): Promise<SheetCreateResult>;
  writeSheet(input: SheetWriteInput, context?: GatewayRequestContext): Promise<boolean>;
  createSheetChart(
    input: SheetChartInput,
    context?: GatewayRequestContext,
  ): Promise<SheetChartResult>;
  createWhiteboard(
    input: WhiteboardCreateInput,
    context?: GatewayRequestContext,
  ): Promise<WhiteboardCreateResult>;
}
