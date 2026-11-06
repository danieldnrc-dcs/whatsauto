// File storage. The default keeps files on disk (MEDIA_DIR). To use S3 or similar, replace these
// three functions: the rest of the code only calls them.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileTypeFromBuffer } from "./mime.ts";
import { config } from "./config.ts";
import { q1 } from "./db.ts";

const safeName = (n: string) => (n.replace(/[\\/\0\r\n]/g, "_").trim().slice(0, 180) || "file");

export async function saveMedia(data: Buffer, name: string, declaredMime = "") {
  if (!data.length) throw new Error("Empty file.");
  if (data.length > config.maxMediaBytes) throw new Error(`File larger than ${config.maxMediaBytes / 1024 / 1024} MB.`);
  const mime = fileTypeFromBuffer(data) || declaredMime.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const key = randomUUID();
  await mkdir(config.mediaDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(config.mediaDir, key), data, { mode: 0o600 });
  return (await q1(
    "insert into media (name, mime, size, storage_key) values ($1,$2,$3,$4) returning id, name, mime, size",
    [safeName(name), mime, data.length, key],
  ))!;
}

export async function readMedia(id: string) {
  const m = await q1("select * from media where id=$1", [id]);
  if (!m) return null;
  return { meta: m, data: await readFile(path.join(config.mediaDir, m.storage_key)) };
}
