import { loadConfig } from "@ojs/core";

/**
 * Background worker: will run scheduled jobs (scanning job boards, checking
 * postings are still live, follow-up reminders) and send notifications.
 *
 * Placeholder until discovery lands. `--once` runs a single tick and exits,
 * which is also how cron, launchd or systemd timers will call it.
 */
const once = process.argv.includes("--once");
const intervalMs = Number(process.env.OJS_WORKER_INTERVAL_MS ?? 30 * 60_000);

async function tick(): Promise<void> {
  const config = await loadConfig();
  console.log(`[${new Date().toISOString()}] worker tick: ${Object.keys(config.providers).length} provider(s) configured, no jobs registered yet`);
}

await tick();
if (!once) setInterval(() => void tick().catch((e) => console.error(e)), intervalMs);
