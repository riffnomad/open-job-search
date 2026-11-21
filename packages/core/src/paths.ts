import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

/**
 * The workspace: the folder holding `documents/` (what you put in) and
 * `data/` (what the tool builds). By default it's this repo: clone it,
 * open your agent in it.
 * Both folders are ignored by git, apart from their READMEs.
 *
 * Several people can share one workspace (you running a job search for
 * someone else too). Each has a folder in both:
 *
 *   documents/<person>/                 their CVs and writing samples
 *   data/<person>/profile/              their experience: who they are
 *   data/<person>/searches/<search>/    what they're looking for, one per search
 *
 * Override the workspace with OJS_ROOT (tests, or keeping your data somewhere
 * else), and who and which search with OJS_PERSON / OJS_SEARCH (what
 * --person and --search set).
 */
export function workspaceRoot(env: Env = process.env): string {
  return env.OJS_ROOT ?? fileURLToPath(new URL("../../../", import.meta.url));
}

/** documents/: everyone's documents, one folder each. */
export function documentsRoot(env?: Env): string {
  return join(workspaceRoot(env), "documents");
}

/** data/: shared config, and one folder per person. */
export function dataRoot(env?: Env): string {
  return join(workspaceRoot(env), "data");
}

export function configPath(env?: Env): string {
  return join(dataRoot(env), "config.json");
}

/** Who and which search we're working on. */
export const ACTIVE_FILE = "active.json";
/** Marks a folder in data/ as a person. */
export const PERSON_FILE = "person.json";
export const SEARCH_FILE = "search.yaml";
export const SEARCHES_DIR = "searches";

export class PersonError extends Error {
  override name = "PersonError";
}

export interface ActiveState {
  version: 1;
  person?: string;
  /** Active search per person. */
  search: Record<string, string>;
}

export function activePath(env?: Env): string {
  return join(dataRoot(env), ACTIVE_FILE);
}

export function readActive(env?: Env): ActiveState {
  try {
    const raw = JSON.parse(readFileSync(activePath(env), "utf8")) as Partial<ActiveState>;
    return {
      version: 1,
      ...(typeof raw.person === "string" ? { person: raw.person } : {}),
      search: raw.search && typeof raw.search === "object" ? raw.search : {},
    };
  } catch {
    return { version: 1, search: {} };
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Ids of everyone set up in this workspace. */
export function personIds(env?: Env): string[] {
  return subdirs(dataRoot(env)).filter((id) => existsSync(join(dataRoot(env), id, PERSON_FILE)));
}

/** A profile from before people existed: data/profile/ straight under data/. */
export function hasLegacyLayout(env?: Env): boolean {
  return existsSync(join(dataRoot(env), "profile"));
}

/**
 * Who we're working on: --person (OJS_PERSON), else the one chosen with
 * `ojs person use`, else the only person there is.
 */
export function activePerson(env?: Env): string {
  const e = env ?? process.env;
  const ids = personIds(env);
  const want = e.OJS_PERSON?.trim();
  if (want) {
    if (!ids.includes(want)) throw new PersonError(`no one called "${want}" here. ${ids.length ? `People: ${ids.join(", ")}` : "Add someone with `ojs person add <name>`."}`);
    return want;
  }
  const chosen = readActive(env).person;
  if (chosen && ids.includes(chosen)) return chosen;
  if (ids.length === 1) return ids[0]!;
  if (!ids.length) {
    if (hasLegacyLayout(env)) throw new PersonError("this profile is from before several people were supported. Move it into a person's folder with `ojs person migrate <name>`.");
    throw new PersonError("no one is set up yet. Add the person whose job search this is with `ojs person add <name>`.");
  }
  throw new PersonError(`there's more than one person here (${ids.join(", ")}). Choose one with \`ojs person use <name>\`, or pass --person.`);
}

/** data/<person>/: everything the tool builds for one person. */
export function personDir(env?: Env, person = activePerson(env)): string {
  return join(dataRoot(env), person);
}

/** documents/<person>/: what they put in. */
export function documentsDir(env?: Env, person = activePerson(env)): string {
  return join(documentsRoot(env), person);
}

export function profileDir(env?: Env, person = activePerson(env)): string {
  return join(personDir(env, person), "profile");
}

export function cacheDir(env?: Env, person = activePerson(env)): string {
  return join(personDir(env, person), "cache");
}

export function writingSamplesDir(env?: Env, person = activePerson(env)): string {
  return join(documentsDir(env, person), "writing-samples");
}

export function searchesDir(env?: Env, person = activePerson(env)): string {
  return join(personDir(env, person), SEARCHES_DIR);
}

export function searchIds(env?: Env, person = activePerson(env)): string[] {
  return subdirs(searchesDir(env, person)).filter((id) => existsSync(join(searchesDir(env, person), id, SEARCH_FILE)));
}

/**
 * Which search: --search (OJS_SEARCH), else the one chosen with
 * `ojs search use`, else the only one. Undefined when there are none yet.
 */
export function activeSearch(env?: Env, person = activePerson(env)): string | undefined {
  const e = env ?? process.env;
  const ids = searchIds(env, person);
  const want = e.OJS_SEARCH?.trim();
  if (want) {
    if (!ids.includes(want)) throw new PersonError(`${person} has no search called "${want}". ${ids.length ? `Searches: ${ids.join(", ")}` : "Add one with `ojs search add <name>`."}`);
    return want;
  }
  const chosen = readActive(env).search[person];
  if (chosen && ids.includes(chosen)) return chosen;
  if (ids.length === 1) return ids[0];
  return undefined;
}

/** data/<person>/searches/<search>/. Throws when there's no search to use. */
export function searchDir(env?: Env, person = activePerson(env)): string {
  const id = activeSearch(env, person);
  if (!id) {
    const ids = searchIds(env, person);
    throw new PersonError(
      ids.length
        ? `${person} has more than one search (${ids.join(", ")}). Choose one with \`ojs search use <name>\`, or pass --search.`
        : `${person} has no job search yet. Add one with \`ojs search add <name>\` (e.g. "software engineering").`,
    );
  }
  return join(searchesDir(env, person), id);
}
