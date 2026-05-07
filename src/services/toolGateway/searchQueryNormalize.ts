export function normalizeDocumentSearchQuery(raw: string, maxLen = 32): string {
  return raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function isNoiseSearchToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  if (!t) return true;
  if (/^_?user[_-]?\d+$/.test(t)) return true;
  if (/^(ou|im|om|oc)_[a-z0-9_]+$/.test(t)) return true;
  return false;
}

export function compactDocumentSearchQuery(raw: string): string {
  const normalized = normalizeDocumentSearchQuery(raw, 48);
  if (!normalized) return "";
  if (normalized.length > 16 && normalized.includes(" ")) {
    const parts = normalized
      .split(" ")
      .map((x) => x.trim())
      .filter(Boolean);
    const meaningful = parts.find((x) => !isNoiseSearchToken(x));
    if (meaningful) return meaningful;
    return parts[0] ?? normalized;
  }
  if (isNoiseSearchToken(normalized)) return "";
  return normalized;
}

