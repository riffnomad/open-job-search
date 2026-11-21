/**
 * What someone wants from a job: where and how they work, pay, the kind of
 * company, what rules a job out, and what matters most to them.
 *
 * Two layers. A person's usual preferences (data/<person>/preferences.yaml)
 * hold what's true for all their searches: where they live, the deal-breakers
 * they always have. Each search (search.yaml) holds only what's different for
 * it: a higher salary floor for a leadership search, say. A second search
 * then needs a couple of questions, not the whole conversation again.
 *
 * Every preference can carry a reason (`reasons`), in their words. "Remote,
 * because I do the school pickup at 3pm" means a hybrid job with flexible
 * hours could still work; "remote, because I hate commuting" doesn't. Later
 * steps use the reasons to spot good exceptions instead of applying rules
 * blindly.
 *
 * Hard rules (deal-breakers, and the salary minimum) rule a job out. Every
 * other preference is scored, weighted by the order of `priorities`.
 */
import { stringify } from "yaml";
import { z } from "zod";

export const USUAL_PREFERENCES_FILE = "preferences.yaml";

export const WORK_MODES = ["remote", "hybrid", "onsite"] as const;
export const JOB_TYPES = ["permanent", "contract", "freelance", "part-time", "temporary", "internship"] as const;
/** Suggested names for priorities, so they compare across searches. Others are allowed. */
export const PRIORITY_SUGGESTIONS = ["pay", "flexibility", "growth", "learning", "mission", "stability", "culture", "title", "location"] as const;

const PreferAvoid = z.object({ prefer: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) });
const Money = z.number().nonnegative();

export const Salary = z.object({
  currency: z.string().length(3).default("GBP"),
  period: z.enum(["year", "day", "hour"]).default("year"),
  /** What their current (or last) package is worth, part by part. */
  current: z
    .object({
      base: Money.optional(),
      bonus: Money.optional(),
      equity: Money.optional(),
      pension: Money.optional(),
      /** Anything else worth money: on-call pay, car allowance, health cover. */
      other: z.string().optional(),
      total: Money.optional(),
    })
    .optional(),
  /** The walk-away number: a hard rule. */
  min: z.number().positive().optional(),
  /** What they're aiming for. */
  target: z.number().positive().optional(),
  /** What to open with when asked. */
  ask: z.number().positive().optional(),
  /** How the numbers were reached: current package, market, what they need. */
  reasoning: z.string().optional(),
});
export type Salary = z.infer<typeof Salary>;

/** A deal-breaker: plain text, or with the reason behind it. */
export const DealBreaker = z.union([z.string().min(1).transform((rule): { rule: string; why?: string } => ({ rule })), z.object({ rule: z.string().min(1), why: z.string().optional() })]);

export const TradeOff = z.object({
  /** What they'd accept that they otherwise wouldn't: "3 office days a week". */
  accept: z.string().min(1),
  /** On what condition: "salary at least 90,000". */
  if: z.string().min(1),
  why: z.string().optional(),
});

/** The fields shared by usual preferences and a search. */
export const preferenceShape = {
  seniority: z.string().optional(),
  locations: z.array(z.string()).default([]),
  workMode: z.array(z.enum(WORK_MODES)).default([]),
  /** The most days a week in an office they'd accept. */
  officeDays: z.number().min(0).max(7).optional(),
  commute: z.string().optional(),
  relocate: z.boolean().optional(),
  jobTypes: z.array(z.enum(JOB_TYPES)).default([]),
  /** "Full time", "4-day week", "school hours". */
  hours: z.string().optional(),
  /** Earliest they could start, or "after notice". */
  startDate: z.string().optional(),
  salary: Salary.optional(),
  dealBreakers: z.array(DealBreaker).default([]),
  industries: PreferAvoid.default({ prefer: [], avoid: [] }),
  /** Kinds of company: startup, scale-up, large company, public sector, agency, nonprofit. */
  companies: PreferAvoid.default({ prefer: [], avoid: [] }),
  /** How they like to work: "small team", "few meetings", "lots of autonomy". */
  workStyle: z.array(z.string()).default([]),
  /** What matters most, most important first. Becomes the weights for scoring jobs. */
  priorities: z.array(z.string().min(1)).default([]),
  tradeOffs: z.array(TradeOff).default([]),
  /** Why, in their words, keyed by preference: { workMode: "school pickup at 3pm" }. */
  reasons: z.record(z.string(), z.string()).default({}),
};

export const Preferences = z.object(preferenceShape);
export type Preferences = z.infer<typeof Preferences>;
export type PreferenceKey = keyof typeof preferenceShape;
export const PREFERENCE_KEYS = Object.keys(preferenceShape) as PreferenceKey[];

export const UsualPreferences = z.object({ version: z.literal(1).default(1), ...preferenceShape });
export type UsualPreferences = z.infer<typeof UsualPreferences>;

/** True when a value holds something: not empty, not only empty lists. */
export function filled(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.values(v).some(filled);
  return v !== null && v !== undefined && v !== "";
}

export type PreferenceSource = "search" | "usual";

export interface EffectivePreferences {
  preferences: Preferences;
  /** Where each preference that's set came from. */
  from: Partial<Record<PreferenceKey, PreferenceSource | "both">>;
}

const EMPTY: Preferences = Preferences.parse({});

function pick(p: Partial<Preferences> | undefined): Preferences {
  const out = { ...EMPTY } as Record<string, unknown>;
  if (p) for (const k of PREFERENCE_KEYS) if (p[k] !== undefined) out[k] = p[k];
  return out as Preferences;
}

/**
 * The preferences a search actually uses: what the search sets, else the
 * person's usual ones. Deal-breakers add up (a search can add its own, never
 * drop the person's), and reasons merge, the search's winning.
 */
export function effectivePreferences(usual: Partial<Preferences> | undefined, search: Partial<Preferences>): EffectivePreferences {
  const u = pick(usual);
  const s = pick(search);
  const out = { ...EMPTY } as Record<PreferenceKey, unknown>;
  const from: EffectivePreferences["from"] = {};
  for (const k of PREFERENCE_KEYS) {
    if (k === "reasons" || k === "dealBreakers") continue;
    if (filled(s[k])) [out[k], from[k]] = [s[k], "search"];
    else if (filled(u[k])) [out[k], from[k]] = [u[k], "usual"];
    else out[k] = EMPTY[k];
  }
  const seen = new Set<string>();
  const breakers = [...s.dealBreakers, ...u.dealBreakers].filter((d) => !seen.has(d.rule.toLowerCase()) && seen.add(d.rule.toLowerCase()));
  out.dealBreakers = breakers;
  if (s.dealBreakers.length || u.dealBreakers.length) from.dealBreakers = s.dealBreakers.length && u.dealBreakers.length ? "both" : s.dealBreakers.length ? "search" : "usual";
  out.reasons = { ...u.reasons, ...s.reasons };
  return { preferences: out as Preferences, from };
}

export interface HardRule {
  rule: string;
  why?: string;
}

const money = (n: number, s: Salary) => `${n.toLocaleString("en-GB")} ${s.currency} a${s.period === "hour" ? "n" : ""} ${s.period}`;

/** What rules a job out completely: deal-breakers, and pay below the minimum. */
export function hardRules(p: Preferences): HardRule[] {
  const rules: HardRule[] = p.dealBreakers.map((d) => ({ rule: d.rule, ...(d.why ? { why: d.why } : {}) }));
  if (p.salary?.min) rules.push({ rule: `Pay at least ${money(p.salary.min, p.salary)}`, ...(p.reasons.salary ? { why: p.reasons.salary } : {}) });
  return rules;
}

/**
 * Weights for scoring jobs, from the order of priorities: the first counts
 * most. Rank-sum weights (n, n-1, ... 1, normalised), so they always add to 1
 * and nobody has to choose percentages.
 */
export function priorityWeights(priorities: string[]): Record<string, number> {
  const list = [...new Set(priorities.map((p) => p.trim().toLowerCase()).filter(Boolean))];
  const total = (list.length * (list.length + 1)) / 2;
  return Object.fromEntries(list.map((p, i) => [p, Math.round(((list.length - i) / total) * 100) / 100]));
}

/** Things that don't fit together, to raise gently before saving. */
export function checkPreferences(p: Preferences): string[] {
  const warnings: string[] = [];
  const s = p.salary;
  if (s) {
    const say = (n: number) => money(n, s);
    if (s.min && s.target && s.min > s.target) warnings.push(`The salary minimum (${say(s.min)}) is above the target (${say(s.target)}).`);
    if (s.target && s.ask && s.ask < s.target) warnings.push(`The opening ask (${say(s.ask)}) is below the target (${say(s.target)}); the ask is usually at or above it.`);
    if (s.min && s.ask && s.ask < s.min) warnings.push(`The opening ask (${say(s.ask)}) is below the minimum (${say(s.min)}).`);
  }
  if (p.workMode.length === 1 && p.workMode[0] === "remote" && p.officeDays) warnings.push(`Remote only, but up to ${p.officeDays} office day${p.officeDays === 1 ? "" : "s"} a week is allowed: is hybrid OK too?`);
  if (p.workMode.some((m) => m !== "remote") && !p.locations.length) warnings.push("Hybrid or office work, but no locations: where?");
  const lower = p.priorities.map((x) => x.trim().toLowerCase());
  if (new Set(lower).size !== lower.length) warnings.push("A priority is listed twice.");
  for (const k of Object.keys(p.reasons)) if (!(PREFERENCE_KEYS as string[]).includes(k)) warnings.push(`reasons.${k} isn't a preference (${PREFERENCE_KEYS.filter((x) => x !== "reasons").join(", ")}).`);
  for (const k of ["industries", "companies"] as const) {
    const both = p[k].prefer.filter((x) => p[k].avoid.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (both.length) warnings.push(`${k}: ${both.join(", ")} is both preferred and avoided.`);
  }
  return warnings;
}

/** Preferences that are set but have no reason yet. */
export function unexplained(p: Preferences): PreferenceKey[] {
  return PREFERENCE_KEYS.filter((k) => {
    if (k === "reasons" || !filled(p[k]) || p.reasons[k]) return false;
    if (k === "dealBreakers") return !p.dealBreakers.every((d) => d.why);
    if (k === "tradeOffs") return !p.tradeOffs.every((t) => t.why);
    if (k === "salary") return !p.salary?.reasoning;
    return true;
  });
}

const BODY = `seniority:         # e.g. senior, lead
locations: []      # e.g. [London, Remote (UK)]
workMode: []       # remote | hybrid | onsite
officeDays:        # the most days a week in an office they'd accept
commute:           # e.g. up to an hour each way
relocate:          # true | false
jobTypes: []       # permanent | contract | freelance | part-time | temporary | internship
hours:             # e.g. full time, 4-day week
startDate:         # earliest start, e.g. after a 3-month notice period
salary:            # { current: { base, bonus, equity, pension, other, total }, min, target, ask, currency: GBP, period: year, reasoning }
dealBreakers: []   # hard rules: a job breaking one is ruled out. "No on-call" or { rule: "No on-call", why: "…" }
industries: { prefer: [], avoid: [] }
companies: { prefer: [], avoid: [] }   # startup, scale-up, large company, public sector, agency, nonprofit
workStyle: []      # how they like to work: small team, few meetings, autonomy
priorities: []     # what matters most, most important first: pay, flexibility, growth, learning, mission, stability, culture
tradeOffs: []      # { accept: "3 office days a week", if: "salary at least 90,000", why: "…" }
reasons: {}        # why, in their words, by preference: { workMode: "school pickup at 3pm" }`;

/** The body of preferences, with comments, for search.yaml and preferences.yaml. */
export function preferencesTemplateBody(): string {
  return BODY;
}

/** preferences.yaml for a person: what's true for all their searches. */
export function usualPreferencesTemplate(): string {
  return `# Your usual preferences: what's true for all your job searches (where you
# live, the deal-breakers you always have). Each search can change any of
# these in its own search.yaml; deal-breakers add up. Everything is optional.
# Change it with \`ojs prefs set --usual\`.
version: 1
${BODY}
`;
}

/** A value as one line of YAML: `[London, Remote (UK)]`, `{min: 60000, currency: GBP}`. */
export function yamlInline(value: unknown): string {
  return stringify(value, { collectionStyle: "flow", flowCollectionPadding: false, lineWidth: 0 }).trim();
}

export interface SetKeyOptions {
  /** Where a key that isn't there yet goes: before this top-level key, when present. */
  before?: string;
  /** Or straight after the first comment line starting with this text ("# fit:"). */
  afterComment?: string;
  /** Or just before the first comment line starting with this text. */
  beforeComment?: string;
  /** Write the value as an indented block rather than on one line (for long values). */
  block?: boolean;
}

/**
 * Set (or with null, empty) one top-level key in a YAML file's text, touching
 * nothing else: comments, spacing and the other keys stay exactly as they
 * were, so the change history shows only what changed. A key that isn't
 * there yet goes where `opts` says, else at the end.
 */
export function setTopLevelKey(text: string, key: string, value: unknown, opts: SetKeyOptions = {}): string {
  const lines = text.split("\n");
  const isTop = (l: string) => /^[^\s#-]/.test(l);
  const start = lines.findIndex((l) => l.startsWith(`${key}:`) && /^\s|$/.test(l.slice(key.length + 1)));
  const rendered =
    value === null ? `${key}:` : opts.block ? stringify({ [key]: value }, { lineWidth: 0 }).trimEnd() : `${key}: ${yamlInline(value)}`;
  if (start < 0) {
    if (value === null) return text;
    let at = opts.before ? lines.findIndex((l) => l.startsWith(`${opts.before}:`)) : -1;
    if (at < 0 && opts.afterComment) {
      const c = lines.findIndex((l) => l.startsWith(opts.afterComment!));
      if (c >= 0) at = c + 1;
    }
    if (at < 0 && opts.beforeComment) at = lines.findIndex((l) => l.startsWith(opts.beforeComment!));
    if (at < 0) at = text.endsWith("\n") ? lines.length - 1 : lines.length;
    lines.splice(at, 0, rendered);
    return lines.join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !isTop(lines[end]!) && !/^#/.test(lines[end]!)) end++;
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  // Keep the comment explaining the key, in the same column (one-line values only).
  const m = /^(.*?\S)(\s+)(#.*)$/.exec(lines[start]!);
  const comment = m && !rendered.includes("\n") && !/["']/.test(m[1]!.slice(key.length + 1)) ? m[3]! : "";
  const column = m ? m[1]!.length + m[2]!.length : 0;
  const line = comment ? `${rendered}${" ".repeat(Math.max(1, column - rendered.length))}${comment}` : rendered;
  lines.splice(start, end - start, line);
  return lines.join("\n");
}
