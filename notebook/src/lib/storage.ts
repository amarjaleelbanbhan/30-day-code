import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Local-disk object storage. Keys are server-generated (`<courseId>/<uuid>.<ext>`); swap this module for
// an S3-compatible adapter in production — callers only use put/get/del.

const root = () => path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR || "./data/uploads");

function resolveKey(key: string): string {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z]{2,5}$/.test(key)) throw new Error("Invalid storage key");
  return path.join(root(), key);
}

export async function put(key: string, bytes: Uint8Array): Promise<void> {
  const p = resolveKey(key);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, bytes);
}

export const get = async (key: string): Promise<Uint8Array> => new Uint8Array(await readFile(resolveKey(key)));

export const del = (key: string) => rm(resolveKey(key), { force: true });
