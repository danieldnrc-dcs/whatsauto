// All settings come from environment variables and are read lazily, so tests can change them.
const bool = (v: string | undefined) => v === "true" || v === "1";

export const config = {
  get databaseUrl() {
    const v = process.env.DATABASE_URL;
    if (!v) throw new Error("DATABASE_URL is not set.");
    return v;
  },
  get secret() {
    const v = process.env.SECRET;
    if (!v || v.length < 32) throw new Error("SECRET is missing or shorter than 32 characters (openssl rand -base64 32).");
    return v;
  },
  get port() { return Number(process.env.PORT || 3000); },
  get mediaDir() { return process.env.MEDIA_DIR || "./data/media"; },
  get maxMediaBytes() { return Number(process.env.MAX_MEDIA_MB || 20) * 1024 * 1024; },
  get sessionId() {
    const n = Number(process.env.SESSION_ID || 1);
    if (!Number.isInteger(n) || n < 1) throw new Error("SESSION_ID is invalid.");
    return n;
  },
  get sendDelayMs() { return Number(process.env.SEND_DELAY_MS || 2000); },
  get includeGroups() { return bool(process.env.INCLUDE_GROUPS); },
  get allowPrivateWebhooks() { return bool(process.env.ALLOW_PRIVATE_WEBHOOKS); },
};
