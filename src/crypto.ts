import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";

// AES-256-GCM. The key is derived from SECRET and never stored in the database.
const key = () => createHash("sha256").update(config.secret).digest();

export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

export function decrypt(value: string): string {
  const [v, iv, tag, data] = value.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Invalid encrypted value.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
