import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { profileDir } from "../paths.ts";
import { parseProfileFile, ProfileFileError, type PastLifeFile, type RoleFile } from "./role-file.ts";
import { ProfileData } from "./schema.ts";

export const PROFILE_FILE = "profile.yaml";
export const ROLES_DIR = "roles";
export const PAST_LIVES_DIR = "past-lives";
export const WRITING_SAMPLES_DIR = "writing-samples";
export const SOURCES_DIR = "sources";
export const HISTORY_DIR = "history";

export interface Profile {
  dir: string;
  /** False when profile.yaml doesn't exist yet (defaults were used). */
  exists: boolean;
  data: ProfileData;
  roles: { file: string; doc: RoleFile }[];
  pastLives: { file: string; doc: PastLifeFile }[];
  /** File names in writing-samples/, for drafting in step 6. */
  writingSamples: string[];
}

/** Every problem found, across all files, so the user can fix them in one go. */
export class ProfileLoadError extends Error {
  override name = "ProfileLoadError";
  constructor(readonly problems: string[]) {
    super(`The profile has ${problems.length === 1 ? "a problem" : `${problems.length} problems`}:\n\n${problems.join("\n\n")}`);
  }
}

export function parseProfileYaml(text: string, file = PROFILE_FILE): ProfileData {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message.split("\n")[0] : String(err);
    throw new ProfileFileError(file, `not valid YAML: ${msg}`);
  }
  const result = ProfileData.safeParse(raw);
  if (!result.success) throw new ProfileFileError(file, `invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}

export async function loadProfile(dir = profileDir()): Promise<Profile> {
  const problems: string[] = [];

  let data = ProfileData.parse({});
  let exists = false;
  const yamlText = await readIfExists(join(dir, PROFILE_FILE));
  if (yamlText !== undefined) {
    exists = true;
    try {
      data = parseProfileYaml(yamlText);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const roles: Profile["roles"] = [];
  for (const file of await markdownFiles(join(dir, ROLES_DIR))) {
    const rel = `${ROLES_DIR}/${file}`;
    try {
      roles.push({ file: rel, doc: parseProfileFile("role", await readFile(join(dir, rel), "utf8"), rel) });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const pastLives: Profile["pastLives"] = [];
  for (const file of await markdownFiles(join(dir, PAST_LIVES_DIR))) {
    const rel = `${PAST_LIVES_DIR}/${file}`;
    try {
      pastLives.push({ file: rel, doc: parseProfileFile("past-life", await readFile(join(dir, rel), "utf8"), rel) });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  if (problems.length) throw new ProfileLoadError(problems);

  // Newest first reads naturally ("current role first"), like a CV.
  roles.sort((a, b) => latestDate(b.doc).localeCompare(latestDate(a.doc)));
  pastLives.sort((a, b) => a.file.localeCompare(b.file));

  const writingSamples = (await listDir(join(dir, WRITING_SAMPLES_DIR))).filter((f) => !f.startsWith(".")).sort();
  return { dir, exists, data, roles, pastLives, writingSamples };
}

/** Current roles sort first; then by most recent end, then start. */
function latestDate(doc: RoleFile): string {
  const ps = doc.frontMatter.positions;
  if (ps.some((p) => !p.end)) return "9999-99";
  return ps.map((p) => p.end ?? p.start).sort().at(-1)!;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function markdownFiles(path: string): Promise<string[]> {
  return (await listDir(path)).filter((f) => f.endsWith(".md") && !f.startsWith(".")).sort();
}
