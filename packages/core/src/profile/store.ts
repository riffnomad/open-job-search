/**
 * Writing the profile. Every change goes through here:
 * - directories 0700, files 0600 (it's personal data)
 * - every change logged as a diff in history.md, so it can be undone
 * - atomic writes (temp file + rename), so a crash never leaves half a file
 * - the result is parsed again before it's written, so the tool can never
 *   save a file it couldn't read back
 */
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { profileDir, SEARCH_FILE } from "../paths.ts";
import { parseSearchYaml, parseUsualPreferences } from "../search.ts";
import { USUAL_PREFERENCES_FILE } from "../preferences.ts";
import {
  loadProfile,
  parseProfileYaml,
  PAST_LIVES_DIR,
  PROFILE_FILE,
  ROLES_DIR,
  type Profile,
} from "./load.ts";
import {
  appendBullets,
  formatTag,
  matchPosition,
  newProfileFile,
  parseProfileFile,
  pastLifeFileName,
  PastLifeFrontMatter,
  renderProfileFile,
  roleFileName,
  RoleFrontMatter,
  slugify,
  withFrontMatter,
  type FileKind,
  type PastLifeFile,
  type RoleFile,
  type Source,
} from "./role-file.ts";
import { readHistory, recordChange, reverseEntry, undoTarget, type HistoryEntry } from "./history.ts";

export class ProfileError extends Error {
  override name = "ProfileError";
}

const DIRS = [ROLES_DIR, PAST_LIVES_DIR];

export async function ensureProfileDirs(dir = profileDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const d of DIRS) await mkdir(join(dir, d), { recursive: true, mode: 0o700 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write atomically with mode 0600, then log the change in history.md.
 * `action` is what the history shows: "dig", "import", "correct", "edit"...
 * Returns the history entry number, or undefined if nothing changed.
 */
export async function writeProfileText(dir: string, rel: string, text: string, action: string): Promise<number | undefined> {
  const path = join(dir, rel);
  const before = await readOrNull(path);
  if (before === text) return undefined;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  return recordChange(dir, rel, before, text, action);
}

export type ProfileEntry =
  | { kind: "role"; file: string; doc: RoleFile }
  | { kind: "past-life"; file: string; doc: PastLifeFile };

export function entries(profile: Profile): ProfileEntry[] {
  return [
    ...profile.roles.map((r) => ({ kind: "role" as const, ...r })),
    ...profile.pastLives.map((p) => ({ kind: "past-life" as const, ...p })),
  ];
}

/**
 * Find a role or past life from what a person (or agent) would type:
 * a file name ("2019-06-acme-logistics", "roles/2019-06-acme-logistics.md")
 * or part of an employer or field name ("acme", "hospitality").
 */
export function resolveEntry(profile: Profile, ref: string): ProfileEntry {
  const all = entries(profile);
  const list = () => all.map((e) => `  ${e.file}`).join("\n") || "  (none yet; add one with `ojs profile add role`)";
  const name = ref.replace(/^(roles|past-lives)\//, "").replace(/\.md$/, "");
  const exact = all.filter((e) => basename(e.file, ".md") === name || e.file === ref);
  if (exact.length === 1) return exact[0]!;

  const want = slugify(ref);
  const label = (e: ProfileEntry) => slugify(e.kind === "role" ? e.doc.frontMatter.employer : e.doc.frontMatter.field);
  const fuzzy = all.filter((e) => basename(e.file, ".md").includes(want) || label(e).includes(want));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) {
    throw new ProfileError(`"${ref}" matches more than one file. Use the file name:\n${fuzzy.map((e) => `  ${e.file}`).join("\n")}`);
  }
  throw new ProfileError(`no role or past life matches "${ref}". Files:\n${list()}`);
}

export async function createEntry(
  kind: FileKind,
  frontMatter: unknown,
  dir = profileDir(),
): Promise<{ file: string; text: string }> {
  let file: string;
  let text: string;
  if (kind === "role") {
    const parsed = RoleFrontMatter.safeParse(frontMatter);
    if (!parsed.success) throw new ProfileError(`invalid role: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    file = `${ROLES_DIR}/${roleFileName(parsed.data)}`;
    text = renderProfileFile(newProfileFile("role", parsed.data));
  } else {
    const parsed = PastLifeFrontMatter.safeParse(frontMatter);
    if (!parsed.success) throw new ProfileError(`invalid past life: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    file = `${PAST_LIVES_DIR}/${pastLifeFileName(parsed.data)}`;
    text = renderProfileFile(newProfileFile("past-life", parsed.data));
  }
  if (await exists(join(dir, file))) throw new ProfileError(`${file} already exists. Add to it with \`ojs profile add-bullets\` or \`ojs profile edit\`.`);
  await writeProfileText(dir, file, text, "create");
  return { file, text };
}

export interface AddBulletsOptions {
  section: string;
  subheading?: string;
  texts: string[];
  source: Source;
  /** Which position (role) or past-life role the bullets belong to: a title, or part of one. */
  position?: string;
  /** Return what would change without writing. */
  dryRun?: boolean;
}

export interface AddBulletsResult {
  file: string;
  section: string;
  subheading?: string;
  /** The position title as written in the file, when one was given. */
  position?: string;
  lines: string[];
  written: boolean;
}

/**
 * The one write path for experience. Appends tagged bullets to a role or
 * past life, then checks the result parses before saving.
 *
 * Guesses must stay out of the bank until confirmed: a bullet whose source
 * is `inferred` can only go under "To confirm".
 */
export async function addBullets(ref: string, opts: AddBulletsOptions, dir = profileDir()): Promise<AddBulletsResult> {
  const texts = opts.texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (texts.length === 0) throw new ProfileError("nothing to add: give at least one non-empty --text");
  if (opts.source.kind === "inferred" && opts.section.trim().toLowerCase() !== "to confirm") {
    throw new ProfileError('inferred bullets can only go under "To confirm" until the user confirms them');
  }

  const profile = await loadProfile(dir);
  const entry = resolveEntry(profile, ref);
  let position: string | undefined;
  if (opts.position?.trim()) {
    const titles =
      entry.kind === "role"
        ? (entry.doc as RoleFile).frontMatter.positions.map((p) => p.title)
        : (entry.doc as PastLifeFile).frontMatter.roles.map((r) => r.title);
    position = matchPosition(titles, opts.position);
    if (!position) {
      throw new ProfileError(
        `no single position in ${entry.file} matches "${opts.position}". Positions: ${titles.map((t) => `"${t}"`).join(", ") || "(none)"}`,
      );
    }
  }
  const bullets = texts.map((text) => ({ text, source: opts.source, ...(position ? { position } : {}) }));
  const updated = appendBullets(entry.doc, opts.section, bullets, { subheading: opts.subheading });
  const text = renderProfileFile(updated);
  parseProfileFile(entry.kind as "role", text, entry.file); // never write what we can't read back

  const lines = texts.map((t) => `- ${t} ${formatTag(opts.source, position)}`);
  const result: AddBulletsResult = {
    file: entry.file,
    section: opts.section,
    ...(opts.subheading ? { subheading: opts.subheading } : {}),
    ...(position ? { position } : {}),
    lines,
    written: false,
  };
  if (opts.dryRun) return result;
  await writeProfileText(dir, entry.file, text, opts.source.kind === "dig" ? "dig" : `add (${opts.source.kind})`);
  return { ...result, written: true };
}

/** profile.yaml for a new profile, with comments explaining each part. */
export const PROFILE_YAML_TEMPLATE = `# Your profile: the short, structured part. True whatever you apply for.
# Your experience lives in roles/ and past-lives/ next to this file, one file each.
# Everything here is optional. \`ojs profile review\` shows what's missing.
version: 1

basics:
  name:
  headline:          # one line, e.g. "Backend engineer, ex-chef"
  location:
  email:
  phone:
  links: []          # - { label: LinkedIn, url: "https://..." }

languages: []        # - { language: English, level: native }   native | fluent | professional | conversational | basic

education: []        # - { institution: ..., qualification: ..., field: ..., start: "2010", end: "2013" }
certifications: []   # - { name: ..., issuer: ..., date: "2022" }
gaps: []             # career breaks, stated plainly: - { start: 2018-01, end: 2018-09, note: Caring for family }

eligibility:
  workAuthorization: []   # - { country: UK, status: settled }   citizen | settled | visa | needs-sponsorship
  constraints: []         # limits on hours or start date: - { kind: hours, note: "20h/week in term time", until: 2027-06 }
  securityClearance: []   # - { country: UK, level: SC }
  noticePeriod:           # e.g. "1 month", "immediately"

# What you're looking for (roles, locations, salary) lives in each search:
# data/<you>/searches/<search>/search.yaml. See \`ojs search\`.
`;

/** Path of a profile file, creating profile.yaml from the template if needed. */
export async function ensureProfileYaml(dir = profileDir()): Promise<string> {
  await ensureProfileDirs(dir);
  const path = join(dir, PROFILE_FILE);
  if (!(await exists(path))) await writeFile(path, PROFILE_YAML_TEMPLATE, { mode: 0o600 });
  return path;
}

/**
 * Find a role or past-life file by name without parsing anything, so a
 * broken file elsewhere never stops the user from opening one to fix it.
 */
export async function findEntryFile(ref: string, dir = profileDir()): Promise<string> {
  const files: string[] = [];
  for (const sub of [ROLES_DIR, PAST_LIVES_DIR]) {
    try {
      for (const f of await readdir(join(dir, sub))) if (f.endsWith(".md") && !f.startsWith(".")) files.push(`${sub}/${f}`);
    } catch {
      // missing folder: nothing there
    }
  }
  const name = ref.replace(/^(roles|past-lives)\//, "").replace(/\.md$/, "");
  const exact = files.filter((f) => basename(f, ".md") === name);
  if (exact.length === 1) return exact[0]!;
  const want = slugify(ref);
  const fuzzy = files.filter((f) => basename(f, ".md").includes(want));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length > 1) throw new ProfileError(`"${ref}" matches more than one file. Use the file name:\n${fuzzy.map((f) => `  ${f}`).join("\n")}`);
  throw new ProfileError(`no role or past life file matches "${ref}". Files:\n${files.map((f) => `  ${f}`).join("\n") || "  (none yet)"}`);
}

/** Read a file the user is about to edit by hand, so the edit can be logged and checked. */
export async function readProfileText(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}

/** Check a profile file's text parses, by what kind of file it is. Throws with the problem. */
export function checkProfileText(rel: string, text: string): void {
  if (rel === PROFILE_FILE) parseProfileYaml(text, rel);
  else if (rel === SEARCH_FILE) parseSearchYaml(text, rel);
  else if (rel === USUAL_PREFERENCES_FILE) parseUsualPreferences(text, rel);
  else if (rel.startsWith(`${ROLES_DIR}/`)) parseProfileFile("role", text, rel);
  else if (rel.startsWith(`${PAST_LIVES_DIR}/`)) parseProfileFile("past-life", text, rel);
  else throw new ProfileError(`${rel} isn't a profile file`);
}

export interface CorrectOptions {
  /** Exact text to find; must occur once. */
  find: string;
  /** Replacement. Ignored with `remove`. */
  replace?: string;
  /** Remove the whole line that contains `find`. */
  remove?: boolean;
  dryRun?: boolean;
}

export interface CorrectResult {
  file: string;
  before: string[];
  after: string[];
  written: boolean;
}

/**
 * Change or remove something the person says is wrong. The only way to change
 * existing lines (add-bullets only appends). Logged as "correct".
 * `ref` is a role or past life, or "profile" / "profile.yaml"; or "search" /
 * "search.yaml" with `dir` a search's folder.
 */
export async function correctProfile(ref: string, opts: CorrectOptions, dir = profileDir()): Promise<CorrectResult> {
  const rel = /^profile(\.ya?ml)?$/i.test(ref) ? PROFILE_FILE : /^search(\.ya?ml)?$/i.test(ref) ? SEARCH_FILE : await findEntryFile(ref, dir);
  const text = await readOrNull(join(dir, rel));
  if (text === null) throw new ProfileError(`${rel} doesn't exist yet`);
  if (!opts.find) throw new ProfileError("--find is required: the exact text to change");
  const count = text.split(opts.find).length - 1;
  if (count === 0) throw new ProfileError(`"${opts.find}" isn't in ${rel}. Copy the text exactly, including punctuation.`);
  if (count > 1) throw new ProfileError(`"${opts.find}" appears ${count} times in ${rel}. Give more of the line so it matches once.`);
  if (!opts.remove && opts.replace === undefined) throw new ProfileError("give --replace \"new text\", or --remove to delete the whole line");

  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.includes(opts.find));
  let next: string;
  let after: string[];
  if (opts.remove) {
    if (opts.find.includes("\n")) throw new ProfileError("--remove works on one line: --find text from within that line");
    next = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
    after = [];
  } else {
    next = text.replace(opts.find, () => opts.replace!);
    after = next.split("\n").slice(i, i + opts.replace!.split("\n").length);
  }
  try {
    checkProfileText(rel, next);
  } catch (err) {
    throw new ProfileError(`that change would break ${rel}, so nothing was changed: ${(err as Error).message}`);
  }
  const result: CorrectResult = { file: rel, before: lines.slice(i, i + opts.find.split("\n").length), after, written: false };
  if (opts.dryRun) return result;
  await writeProfileText(dir, rel, next, "correct");
  return { ...result, written: true };
}

export interface UndoPlan {
  entry: HistoryEntry;
  /** The file's text after the undo; null means the file will be removed. */
  text: string | null;
}

/** Work out how to reverse the latest change (or change #n), without writing. */
export async function planUndo(dir = profileDir(), n?: number): Promise<UndoPlan> {
  const entry = undoTarget(await readHistory(dir), n);
  const current = await readOrNull(join(dir, entry.file));
  const text = reverseEntry(entry, current);
  if (text !== null) {
    try {
      checkProfileText(entry.file, text);
    } catch (err) {
      throw new ProfileError(`undoing #${entry.n} would leave ${entry.file} broken: ${(err as Error).message}`);
    }
  }
  return { entry, text };
}

export async function applyUndo(plan: UndoPlan, dir = profileDir()): Promise<number | undefined> {
  const action = `undo #${plan.entry.n}`;
  if (plan.text !== null) return writeProfileText(dir, plan.entry.file, plan.text, action);
  const path = join(dir, plan.entry.file);
  const before = await readFile(path, "utf8");
  await unlink(path);
  return recordChange(dir, plan.entry.file, before, null, action);
}

/** Where each role section's content goes in a past life. Anything not listed keeps its heading. */
const ROLE_TO_PAST_LIFE: Record<string, string> = {
  context: "What I did",
  "what i owned": "What I did",
  achievements: "What I did",
  "hard moments": "Stories",
  stories: "Stories",
  "skills in depth": "Trade knowledge",
  "to confirm": "To confirm",
  "still to ask": "Still to ask",
};

export interface MoveOptions {
  /** The past life's field, e.g. "Hospitality". Defaults to the role's industry. An existing past life with this field is added to. */
  field?: string;
  dryRun?: boolean;
}

export interface MoveResult {
  from: string;
  to: string;
  /** Added to a past life that already existed. */
  merged: boolean;
  /** Lines carried over (bullets, subheadings and notes). */
  lines: number;
  /** Where each role section went. */
  sections: { from: string; to: string }[];
  written: boolean;
}

function periodOf(p: { start: string; end?: string | undefined }): string {
  return `${p.start} to ${p.end ?? "present"}`;
}

/** Add raw section content, keeping plain lines out of the last `### ` block. */
function addRaw(doc: PastLifeFile, heading: string, body: string): PastLifeFile {
  const sections = doc.sections.slice();
  const idx = sections.findIndex((s) => s.heading.trim().toLowerCase() === heading.toLowerCase());
  if (idx === -1) {
    // A heading past lives don't have: put it before To confirm / Still to ask.
    let at = sections.findIndex((s) => ["to confirm", "still to ask"].includes(s.heading.trim().toLowerCase()));
    if (at === -1) at = sections.length;
    sections.splice(at, 0, { heading, headingLine: `## ${heading}`, raw: `${body}\n` });
    return { ...doc, sections };
  }
  const s = sections[idx]!;
  const lines = s.raw.replace(/\n+$/, "").split("\n");
  const existing = s.raw.trim() === "" ? [] : lines;
  const firstSub = existing.findIndex((l) => /^### /.test(l));
  let merged: string[];
  if (firstSub !== -1 && !/^### /.test(body)) {
    const before = existing.slice(0, firstSub);
    while (before.length && before.at(-1)!.trim() === "") before.pop();
    merged = [...before, ...body.split("\n"), "", ...existing.slice(firstSub)];
  } else {
    merged = [...existing, ...body.split("\n")];
  }
  sections[idx] = { ...s, raw: `${merged.join("\n")}\n` };
  return { ...doc, sections };
}

/**
 * Turn a role into a past life (an earlier career), keeping every line with
 * its source. Adds to an existing past life with the same field. Logged as
 * two changes: the past life written, then the role file removed.
 */
export async function moveToPastLife(ref: string, opts: MoveOptions = {}, dir = profileDir()): Promise<MoveResult> {
  const profile = await loadProfile(dir);
  const entry = resolveEntry(profile, ref);
  if (entry.kind !== "role") throw new ProfileError(`${entry.file} is already a past life`);
  const role = entry.doc.frontMatter;
  const field = (opts.field ?? role.industry ?? "").trim();
  if (!field) throw new ProfileError(`what field was this? Give --field, e.g. --field "Hospitality" (${entry.file} has no industry to use)`);

  const to = `${PAST_LIVES_DIR}/${pastLifeFileName({ field, roles: [] })}`;
  const existing = profile.pastLives.find((p) => p.file === to);
  let doc: PastLifeFile = existing ? existing.doc : newProfileFile("past-life", { field, roles: [] });

  const fm = doc.frontMatter;
  const newRoles = role.positions.map((p) => ({ title: p.title, employer: role.employer, period: periodOf(p) }));
  const skills = [...new Set([...(fm.skills ?? []), ...role.skills])];
  doc = withFrontMatter(doc, { ...fm, roles: [...fm.roles, ...newRoles], ...(skills.length ? { skills } : {}) });

  const sections: MoveResult["sections"] = [];
  let lines = 0;
  // Several role sections can land in one heading; gather them in order first.
  const gathered = new Map<string, string[]>();
  for (const s of entry.doc.sections) {
    const body = s.raw.replace(/^\n+|\n+$/g, "");
    if (!body.trim()) continue;
    const target = ROLE_TO_PAST_LIFE[s.heading.trim().toLowerCase()] ?? s.heading.trim();
    gathered.set(target, [...(gathered.get(target) ?? []), body]);
    sections.push({ from: s.heading.trim(), to: target });
    lines += body.split("\n").filter((l) => l.trim()).length;
  }
  for (const [heading, bodies] of gathered) doc = addRaw(doc, heading, bodies.join("\n"));

  const text = renderProfileFile(doc);
  parseProfileFile("past-life", text, to); // never write what we can't read back
  const result: MoveResult = { from: entry.file, to, merged: Boolean(existing), lines, sections, written: false };
  if (opts.dryRun) return result;

  await writeProfileText(dir, to, text, `move from ${entry.file}`);
  const path = join(dir, entry.file);
  const before = await readFile(path, "utf8");
  await unlink(path);
  await recordChange(dir, entry.file, before, null, `move to ${to}`);
  return { ...result, written: true };
}
