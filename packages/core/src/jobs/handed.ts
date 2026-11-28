/**
 * Jobs the person's agent found itself and hands to ojs, for sources ojs
 * can't reach. Indeed's MCP server serves only approved AI apps (Claude,
 * ChatGPT), and tokens issued to anyone else are refused, so ojs never
 * calls it; the person adds Indeed's connector to their AI app, the agent
 * searches with it, and passes what it found here to be judged and shown
 * like any other job.
 *
 * What comes in is data the agent wrote from what a source told it: checked
 * field by field, and an entry that doesn't hold up is skipped with a reason,
 * never guessed at.
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Job, Pay } from "./job.ts";
import { saysRemote, splitLocations } from "./job.ts";
import { SourceError } from "./source.ts";
import { parseSalary } from "./sources/remotive.ts";

/** Sources jobs can be handed over from: ones ojs can't call, but an AI app's own connector can. */
export interface HandedSource {
  id: string;
  name: string;
  /** How the agent reaches it. */
  via: string;
  credit?: string;
  /**
   * When the ids and links the source hands out don't name a job for good,
   * the job's id comes from what it is (company, title, place) instead.
   * Indeed's connector numbers results by their place in each search
   * ("JOBSEARCH_4") and gives a new short link on every call.
   */
  idsUnstable?: boolean;
}

export const HANDED_SOURCES: Record<string, HandedSource> = {
  indeed: {
    id: "indeed",
    name: "Indeed",
    via: "Indeed's connector in Claude (claude.ai: Search and tools, Add connectors, Indeed)",
    credit: "Jobs from Indeed (https://www.indeed.com), found through its connector",
    idsUnstable: true,
  },
};

export function handedSource(id: string): HandedSource {
  const s = HANDED_SOURCES[id.trim().toLowerCase()];
  if (!s) throw new SourceError(`jobs can't be handed over from "${id}". From: ${Object.keys(HANDED_SOURCES).join(", ")}. Job boards ojs reads itself: ojs jobs search.`);
  return s;
}

const text = z.string().trim().min(1);
const opt = z.string().trim().nullish();
const StructuredPay = z.object({
  min: z.number().positive().nullish(),
  max: z.number().positive().nullish(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/),
  period: z.enum(["year", "month", "day", "hour"]).nullish(),
});

/** One job as the agent hands it over. Only title, company and a link are needed. */
const Handed = z.object({
  /** The source's own id for the job, when it gives one. */
  id: z.union([z.string(), z.number()]).nullish(),
  title: text,
  company: text,
  locations: z.array(z.string()).nullish(),
  location: opt,
  url: z.string().trim().url().refine((u) => /^https?:\/\//i.test(u), "must be a web link"),
  /** As the source wrote it ("£60,000 - £70,000 a year"), or already split. */
  pay: z.union([z.string(), StructuredPay]).nullish(),
  postedAt: opt,
  remote: z.boolean().nullish(),
  description: opt,
  /** Short notes the source showed, in its words: "Full-time", "Urgently hiring". */
  signals: z.array(z.string()).nullish(),
});

/** A short, stable id from a link, for jobs handed over without one. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
}

/** A date as YYYY-MM-DD, from ISO or the way people write it ("August 18, 2026"), read as that calendar day. */
export function dayOf(s: string): string | undefined {
  const t = s.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (iso) return t;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return undefined;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function payOf(p: z.infer<typeof Handed>["pay"], description: string[]): Pay[] {
  if (!p) return [];
  if (typeof p !== "string") {
    if (!p.min && !p.max) return [];
    return [{ ...(p.min ? { min: p.min } : {}), ...(p.max ? { max: p.max } : {}), currency: p.currency.toUpperCase(), ...(p.period ? { period: p.period } : {}) }];
  }
  const read = parseSalary(p);
  // Pay we can't read for sure stays as written, where people will see it.
  if (!read && p.trim()) description.push(`Pay, as the source gives it: ${p.trim()}`);
  return read ? [read] : [];
}

function toJob(source: HandedSource, h: z.infer<typeof Handed>): Job {
  const locations = splitLocations(...(h.locations ?? []), h.location);
  const extra: string[] = [];
  const pay = payOf(h.pay, extra);
  const description = [h.description?.trim() ?? "", ...extra].filter(Boolean).join("\n\n");
  const posted = h.postedAt ? dayOf(h.postedAt) : undefined;
  const signals = (h.signals ?? []).map((s) => s.trim()).filter(Boolean);
  const id = source.idsUnstable
    ? hashOf([h.company, h.title, ...locations].map((x) => x.trim().toLowerCase().replace(/\s+/g, " ")).join("|"))
    : h.id != null && String(h.id).trim() ? String(h.id).trim() : hashOf(h.url);
  return {
    id: `${source.id}:jobs:${id}`,
    source: source.id,
    board: "jobs",
    company: h.company,
    title: h.title,
    locations,
    ...(h.remote || saysRemote(locations) ? { remote: true as const } : {}),
    url: h.url,
    ...(posted ? { postedAt: posted } : {}),
    pay,
    ...(description ? { description } : {}),
    ...(signals.length ? { signals } : {}),
  };
}

export interface HandedJobs {
  jobs: Job[];
  /** Entries left out, by their place in the list (from 1), and why. */
  skipped: { entry: number; why: string }[];
}

/** Jobs handed over as a YAML or JSON list. Repeats (the same id) are kept once. */
export function parseHandedJobs(input: string, sourceId: string): HandedJobs {
  const source = handedSource(sourceId);
  let raw: unknown;
  try {
    raw = parseYaml(input);
  } catch (e) {
    throw new SourceError(`that isn't valid YAML or JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs) ? (raw as { jobs: unknown[] }).jobs : undefined;
  if (!list) throw new SourceError("give a list of jobs: [{title, company, url, location, pay, postedAt}, …]");
  const jobs: Job[] = [];
  const seen = new Set<string>();
  const skipped: HandedJobs["skipped"] = [];
  list.forEach((item, i) => {
    const h = Handed.safeParse(item);
    if (!h.success) return void skipped.push({ entry: i + 1, why: h.error.issues.map((x) => `${x.path.join(".") || "entry"}: ${x.message}`).join("; ") });
    const job = toJob(source, h.data);
    if (seen.has(job.id)) return void skipped.push({ entry: i + 1, why: "the same job again" });
    seen.add(job.id);
    jobs.push(job);
  });
  return { jobs, skipped };
}
