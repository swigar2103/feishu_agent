import fs from "node:fs";
import path from "node:path";
import { getWritableDataDir } from "../../../../storage/writableDataDir.js";

function hmrsDataDir(): string {
  return path.join(getWritableDataDir(), "hmrs");
}

function resolveFile(name: string): string {
  return path.join(hmrsDataDir(), name);
}

export function readJsonFile<T>(name: string, fallback: T): T {
  const file = resolveFile(name);
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(name: string, payload: T): void {
  const file = resolveFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
}

export function appendJsonLine(name: string, payload: unknown): void {
  const file = resolveFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf-8");
}
