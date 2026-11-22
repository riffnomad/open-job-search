/**
 * One job ad, in the same shape whichever source it came from. Sources fill
 * what they know and leave the rest out: a missing field means "the source
 * didn't say", never "no".
 */

export interface Pay {
  min?: number;
  max?: number;
  /** ISO 4217, e.g. "GBP". */
  currency: string;
  /** Left out when the source doesn't say. */
  period?: "year" | "month" | "day" | "hour";
  /** What the range covers, as the ad puts it ("United States salary range"). */
  label?: string;
}

export interface Job {
  /** Stable across fetches: `<source>:<board>:<id at the source>`. */
  id: string;
  /** Which source module: "greenhouse". */
  source: string;
  /** The company's board at that source ("acme"); for a job board, the part searched ("gb", "remote"). */
  board: string;
  company: string;
  title: string;
  /** As the ad writes them: "London, UK", "Remote, United States". */
  locations: string[];
  /** True when the ad says remote. Left out when it doesn't say. */
  remote?: true;
  /** The ad itself, where people read it and apply. */
  url: string;
  department?: string;
  /** ISO 8601. When it was first published, if the source says. */
  postedAt?: string;
  /** ISO 8601. When it last changed. */
  updatedAt?: string;
  pay: Pay[];
  /** The full ad as plain text. */
  description?: string;
}

/** What one fetch of one company's board brought back. */
export interface BoardResult {
  source: string;
  board: string;
  company: string;
  jobs: Job[];
  /** How many ads the board has, set only when a source stopped before reading them all. */
  totalAds?: number;
  /** ISO 8601. */
  fetchedAt: string;
}

/** "Remote" written in a location. */
export const saysRemote = (locations: string[]): boolean => locations.some((l) => /\bremote\b/i.test(l));

/** One location field that holds several ("London, UK; New York, NY | Seattle, WA"), as a list without repeats. */
export function splitLocations(...fields: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const f of fields) for (const part of (f ?? "").split(/\s*[|;]\s*/)) {
    const l = part.trim();
    if (l && !out.some((x) => x.toLowerCase() === l.toLowerCase())) out.push(l);
  }
  return out;
}

/**
 * The same job posted more than once on a board, usually once per city or
 * country, each with its own ad and often its own pay. Grouped by company,
 * title and department; every ad, location and pay range is kept.
 */
export interface JobGroup {
  company: string;
  title: string;
  department?: string;
  locations: string[];
  remote?: true;
  pay: Pay[];
  /** The newest of the ads' dates. */
  postedAt?: string;
  /** The ads, newest first. */
  jobs: Job[];
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function groupJobs(jobs: Job[]): JobGroup[] {
  const byKey = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = [norm(j.company), norm(j.title), norm(j.department)].join("\u0000");
    byKey.set(k, [...(byKey.get(k) ?? []), j]);
  }
  return [...byKey.values()].map((list) => {
    const ads = [...list].sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
    const first = ads[0]!;
    const pay: Pay[] = [];
    for (const p of ads.flatMap((a) => a.pay)) if (!pay.some((q) => JSON.stringify(q) === JSON.stringify(p))) pay.push(p);
    const locations = splitLocations(...ads.flatMap((a) => a.locations));
    return {
      company: first.company,
      title: first.title,
      ...(first.department ? { department: first.department } : {}),
      locations,
      ...(ads.some((a) => a.remote) ? { remote: true as const } : {}),
      pay,
      ...(first.postedAt ? { postedAt: first.postedAt } : {}),
      jobs: ads,
    };
  });
}
