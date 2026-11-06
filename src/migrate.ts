// Applies sql/*.sql in order, once each. Safe to run on every deploy.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, q, tx } from "./db.ts";

export async function migrate(dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sql")) {
  await q("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await q("select name from _migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    await tx(async (c) => {
      await c.query(sql);
      await c.query("insert into _migrations (name) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate()
    .then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "Database is up to date."))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(closeDb);
}
