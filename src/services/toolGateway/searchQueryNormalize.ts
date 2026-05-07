export function normalizeDocumentSearchQuery(raw: string, maxLen = 32): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function compactDocumentSearchQuery(raw: string): string {
  const normalized = normalizeDocumentSearchQuery(raw, 48);
  if (normalized.length > 16 && normalized.includes(" ")) {
    return normalized.split(" ")[0] ?? normalized;
  }
  return normalized;
}

