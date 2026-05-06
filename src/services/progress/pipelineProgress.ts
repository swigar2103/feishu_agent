type PipelineProgressEvent = {
  sessionId: string;
  stage: string;
  message: string;
  ts: string;
  meta?: Record<string, unknown>;
};

type SessionChannel = {
  events: PipelineProgressEvent[];
  listeners: Set<(event: PipelineProgressEvent) => void>;
};

const channels = new Map<string, SessionChannel>();
const MAX_EVENTS_PER_SESSION = 200;

function ensureChannel(sessionId: string): SessionChannel {
  const existing = channels.get(sessionId);
  if (existing) return existing;
  const created: SessionChannel = { events: [], listeners: new Set() };
  channels.set(sessionId, created);
  return created;
}

export function publishPipelineProgress(input: {
  sessionId: string;
  stage: string;
  message: string;
  meta?: Record<string, unknown>;
}): void {
  const event: PipelineProgressEvent = {
    sessionId: input.sessionId,
    stage: input.stage,
    message: input.message,
    ts: new Date().toISOString(),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  const channel = ensureChannel(input.sessionId);
  channel.events.push(event);
  if (channel.events.length > MAX_EVENTS_PER_SESSION) {
    channel.events.splice(0, channel.events.length - MAX_EVENTS_PER_SESSION);
  }
  for (const listener of channel.listeners) {
    listener(event);
  }
}

export function getPipelineProgressSnapshot(sessionId: string): PipelineProgressEvent[] {
  return [...(channels.get(sessionId)?.events ?? [])];
}

export function subscribePipelineProgress(
  sessionId: string,
  listener: (event: PipelineProgressEvent) => void,
): () => void {
  const channel = ensureChannel(sessionId);
  channel.listeners.add(listener);
  return () => {
    const current = channels.get(sessionId);
    if (!current) return;
    current.listeners.delete(listener);
  };
}

export type { PipelineProgressEvent };

