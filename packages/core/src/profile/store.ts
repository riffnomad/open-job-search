/**
 * Writing the profile. Every change goes through here:
 * - directories 0700, files 0600 (it's personal data)
 * - a snapshot in history/ before any existing file changes
 * - atomic writes (temp file + rename), so a crash never leaves half a file
 * - the result is parsed again before it's written, so the tool can never
 *   save a file it couldn't read back
 */
import { access, copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { profileDir } from "../paths.ts";
import {
  HISTORY_DIR,
  loadProfile,
  PAST_LIVES_DIR,
  PROFILE_FILE,
  ROLES_DIR,
  SOURCES_DIR,
  WRITING_SAMPLES_DIR,
  type Profile,
} from "./load.ts";
import {
  appendBullets,
  formatSource,
  newProfileFile,
  parseProfileFile,
  pastLifeFileName,
  PastLifeFrontMatter,
  renderProfileFile,
  roleFileName,
  RoleFrontMatter,
  slugify,
  type FileKind,
  type PastLifeFile,
  type RoleFile,
  type Source,
} from "./role-file.ts";

export class ProfileError extends Error {
  override name = "ProfileError";
}

const DIRS = [ROLES_DIR, PAST_LIVES_DIR, WRITING_SAMPLES_DIR, SOURCES_DIR, HISTORY_DIR];

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

/** Copy a file into history/ before it changes. Returns the snapshot path, or undefined if there was nothing to keep. */
export async function snapshot(dir: string, rel: string, now = new Date()): Promise<string | undefined> {
  const src = join(dir, rel);
  if (!(await exists(src))) return undefined;
  await mkdir(join(dir, HISTORY_DIR), { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, HISTORY_DIR, `${stamp}__${rel.replace(/[\\/]/g, "__")}`);
  await copyFile(src, dest);
  return dest;
}

/** Snapshot (if the file exists), then write atomically with mode 0600. */
export async function writeProfileText(dir: string, rel: string, text: string): Promise<void> {
  await ensureProfileDirs(dir);
  await snapshot(dir, rel);
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
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
  await writeProfileText(dir, file, text);
  return { file, text };
}

export interface AddBulletsOptions {
  section: string;
  subheading?: string;
  texts: string[];
  source: Source;
  /** Return what would change without writing. */
  dryRun?: boolean;
}

export interface AddBulletsResult {
  file: string;
  section: string;
  subheading?: string;
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
  const bullets = texts.map((text) => ({ text, source: opts.source }));
  const updated = appendBullets(entry.doc, opts.section, bullets, { subheading: opts.subheading });
  const text = renderProfileFile(updated);
  parseProfileFile(entry.kind as "role", text, entry.file); // never write what we can't read back

  const lines = texts.map((t) => `- ${t} ${formatSource(opts.source)}`);
  const result: AddBulletsResult = {
    file: entry.file,
    section: opts.section,
    ...(opts.subheading ? { subheading: opts.subheading } : {}),
    lines,
    written: false,
  };
  if (opts.dryRun) return result;
  await writeProfileText(dir, entry.file, text);
  return { ...result, written: true };
}

/** profile.yaml for a new profile, with comments explaining each part. */
export const PROFILE_YAML_TEMPLATE = `# Your profile: the short, structured part.
# Your experience lives in roles/ and past-lives/, one file each.
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

positioning: []      # optional angles: - { name: ..., targetTitles: [...], theyBuy: ..., leadWith: [...] }

preferences:
  targetRoles: []
  seniority:
  locations: []      # e.g. [London, Remote (UK)]
  workMode: []       # remote | hybrid | onsite
  salary:            # { min: 60000, target: 70000, currency: GBP, period: year }
  noticePeriod:
  dealBreakers: []
  industries: { prefer: [], avoid: [] }
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

/** Read a file the user is about to edit by hand, for snapshot + validation around the edit. */
export async function readProfileText(dir: string, rel: string): Promise<string> {
  return readFile(join(dir, rel), "utf8");
}
