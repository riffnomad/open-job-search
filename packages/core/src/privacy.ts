/**
 * A guard against personal details ending up in the public repo. The repo
 * is public, and examples written while working on it can quietly pick up
 * real names from the profiles in data/. The pre-commit and commit-msg
 * hooks (.githooks/) run `ojs privacy check`, which refuses a commit whose
 * added lines or message contain a name from anyone's profile: their names,
 * employers, email addresses, phone numbers and links.
 *
 * Everything is read from the local files; nothing leaves the machine.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { dataRoot, PERSON_FILE } from "./paths.ts";

type Env = Record<string, string | undefined>;

/** Words too common to block on their own, when they're part of a longer name. */
const COMMON = new Set(
  "the and for with company group limited ltd inc llc plc gmbh corp corporation labs lab technologies technology tech solutions services global digital systems software partners holdings international university college school ventures studio studios consulting media health bank capital".split(" "),
);

async function readOr(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function safeYaml(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return parseYaml(text);
  } catch {
    return undefined;
  }
}

function frontMatter(text: string | undefined): Record<string, unknown> {
  const m = text ? /^---\r?\n([\s\S]*?)\r?\n---/.exec(text) : null;
  const fm = m ? safeYaml(m[1]) : undefined;
  return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A name, plus each distinctive word in it ("Acme Logistics (Route Planner)" → "Acme", "Logistics", "Route", "Planner"). */
function withParts(name: string): string[] {
  const parts = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !COMMON.has(w.toLowerCase()));
  return [name, ...parts];
}

/** Every name in every profile in this workspace that must never be committed. */
export async function privateTerms(env?: Env): Promise<string[]> {
  const terms = new Set<string>();
  const add = (v: unknown, parts = true) => {
    const s = str(v);
    if (!s || s.length < 3) return;
    for (const t of parts ? withParts(s) : [s]) if (t.length >= 3) terms.add(t);
  };
  const root = dataRoot(env);
  for (const person of await list(root)) {
    const dir = join(root, person);
    const meta = safeYaml(await readOr(join(dir, PERSON_FILE))) as { name?: unknown } | undefined;
    if (!meta) continue;
    add(meta.name);
    const profile = join(dir, "profile");
    const yaml = safeYaml(await readOr(join(profile, "profile.yaml"))) as { basics?: Record<string, unknown> } | undefined;
    const b = yaml?.basics ?? {};
    add(b.name);
    add(b.email, false);
    const phone = str(b.phone)?.replace(/\D/g, "");
    if (phone && phone.length >= 7) terms.add(phone);
    for (const l of Array.isArray(b.links) ? b.links : []) add((l as { url?: unknown })?.url, false);
    for (const sub of ["roles", "past-lives"]) {
      for (const f of await list(join(profile, sub))) {
        if (!f.endsWith(".md")) continue;
        const fm = frontMatter(await readOr(join(profile, sub, f)));
        add(fm.employer);
        // The file name carries the employer too: 2022-01-acme-co.md
        const slug = f.replace(/\.md$/, "").replace(/^\d{4}(-\d{2})?-/, "");
        if (sub === "roles" && slug.length >= 4) terms.add(slug);
      }
    }
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

export interface PrivateHit {
  term: string;
  /** Where: a file and line from a diff, or "commit message". */
  where: string;
  text: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines that contain a term, as a whole word, ignoring case. */
export function findPrivate(lines: { where: string; text: string }[], terms: string[]): PrivateHit[] {
  if (!terms.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${terms.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "iu");
  const hits: PrivateHit[] = [];
  for (const l of lines) {
    const m = re.exec(l.text);
    if (m) hits.push({ term: m[1]!, where: l.where, text: l.text.trim().slice(0, 160) });
  }
  return hits;
}

/** Added lines from a unified diff (`git diff --cached -U0`), with file and line. */
export function addedLines(diff: string): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  let file = "";
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.replace(/^\+\+\+ (b\/)?/, "");
    else if (l.startsWith("@@")) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith("+")) out.push({ where: `${file}:${line++}`, text: l.slice(1) });
    else if (!l.startsWith("-")) line++;
  }
  return out;
}
