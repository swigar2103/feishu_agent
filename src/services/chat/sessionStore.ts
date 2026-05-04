import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WriterOutputSchema, type WriterOutput } from "../../schemas/index.js";

const DIR = path.resolve(process.cwd(), "data", "chat_sessions");

const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.string(),
  revisionMode: z.enum(["full", "incremental"]).optional(),
  mentionedResourceIds: z.array(z.string()).optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const ChatSessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  industry: z.string().optional(),
  reportType: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(ChatMessageSchema),
  latestReport: WriterOutputSchema.optional(),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

function sessionPath(id: string) {
  return path.join(DIR, `${id}.json`);
}

export function createChatSession(input: {
  userId: string;
  industry?: string;
  reportType?: string;
}): ChatSession {
  ensureDir();
  const sessionId = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const session: ChatSession = {
    sessionId,
    userId: input.userId,
    industry: input.industry,
    reportType: input.reportType,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  fs.writeFileSync(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export function loadChatSession(sessionId: string): ChatSession | null {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
  return ChatSessionSchema.parse(raw);
}

export function saveChatSession(session: ChatSession): void {
  ensureDir();
  const parsed = ChatSessionSchema.parse(session);
  fs.writeFileSync(sessionPath(parsed.sessionId), JSON.stringify(parsed, null, 2), "utf-8");
}

export function listChatSessionsForUser(userId: string): Array<{
  sessionId: string;
  updatedAt: string;
  preview: string;
}> {
  ensureDir();
  const out: Array<{ sessionId: string; updatedAt: string; preview: string }> = [];
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith(".json")) continue;
    try {
      const s = loadChatSession(name.replace(".json", ""));
      if (!s || s.userId !== userId) continue;
      const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
      out.push({
        sessionId: s.sessionId,
        updatedAt: s.updatedAt,
        preview: lastUser?.content?.slice(0, 80) ?? "(空会话)",
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function appendChatMessage(
  sessionId: string,
  msg: Omit<ChatMessage, "id" | "createdAt"> & { id?: string },
): ChatSession {
  const session = loadChatSession(sessionId);
  if (!session) throw new Error("session not found");
  const message: ChatMessage = {
    ...msg,
    id: msg.id ?? `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
  };
  const next: ChatSession = {
    ...session,
    updatedAt: message.createdAt,
    messages: [...session.messages, message],
  };
  saveChatSession(next);
  return next;
}

export function setLatestReport(sessionId: string, report: WriterOutput): ChatSession {
  const session = loadChatSession(sessionId);
  if (!session) throw new Error("session not found");
  const next = ChatSessionSchema.parse({
    ...session,
    updatedAt: new Date().toISOString(),
    latestReport: WriterOutputSchema.parse(report),
  });
  saveChatSession(next);
  return next;
}

export function deleteChatSession(sessionId: string): boolean {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}
