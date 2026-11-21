/**
 * People and their searches. One workspace can hold several people (you, and
 * someone whose search you're running for them), and each person can run
 * several searches. See paths.ts for the layout.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import {
  activePath,
  activePerson,
  activeSearch,
  dataRoot,
  documentsRoot,
  hasLegacyLayout,
  PERSON_FILE,
  PersonError,
  personIds,
  readActive,
  SEARCH_FILE,
  searchesDir,
  searchIds,
  type ActiveState,
} from "./paths.ts";
import { slugify } from "./profile/role-file.ts";
import { ensureProfileDirs, writeProfileText } from "./profile/store.ts";
import { PROFILE_FILE } from "./profile/load.ts";
import { loadSearch, searchYamlTemplate, type SearchData } from "./search.ts";

type Env = Record<string, string | undefined>;

export interface PersonInfo {
  id: string;
  /** As they wrote it: "Sam", "Sam Lee". */
  name: string;
  active: boolean;
  searches: string[];
}

export interface SearchInfo {
  id: string;
  name: string;
  targetRoles: string[];
  active: boolean;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

async function writeActive(state: ActiveState, env?: Env): Promise<void> {
  await mkdir(dataRoot(env), { recursive: true, mode: 0o700 });
  await writeJson(activePath(env), state);
}

function idFor(name: string, kind: string): string {
  const id = slugify(name.trim());
  if (!id) throw new PersonError(`give the ${kind} a name with at least one letter or number`);
  return id;
}

async function personName(id: string, env?: Env): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(join(dataRoot(env), id, PERSON_FILE), "utf8")) as { name?: unknown };
    return typeof raw.name === "string" && raw.name ? raw.name : id;
  } catch {
    return id;
  }
}

function tryActivePerson(env?: Env): string | undefined {
  try {
    return activePerson(env);
  } catch {
    return undefined;
  }
}

export async function listPeople(env?: Env): Promise<PersonInfo[]> {
  const active = tryActivePerson(env);
  return Promise.all(personIds(env).map(async (id) => ({ id, name: await personName(id, env), active: id === active, searches: searchIds(env, id) })));
}

/** The active person, with their name. Throws PersonError when there isn't one. */
export async function currentPerson(env?: Env): Promise<{ id: string; name: string }> {
  const id = activePerson(env);
  return { id, name: await personName(id, env) };
}

async function createPersonFolders(id: string, name: string, env?: Env, now = new Date()): Promise<void> {
  const dir = join(dataRoot(env), id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeJson(join(dir, PERSON_FILE), { version: 1, name, createdAt: now.toISOString() });
  await ensureProfileDirs(join(dir, "profile"));
  await mkdir(join(documentsRoot(env), id, "writing-samples"), { recursive: true, mode: 0o700 });
}

/** Set up someone new, and make them the one we're working on. */
export async function addPerson(name: string, env?: Env, now = new Date()): Promise<PersonInfo> {
  const id = idFor(name, "person");
  if (existsSync(join(dataRoot(env), id))) throw new PersonError(`there's already a folder for "${id}" in data/. Use \`ojs person use ${id}\`.`);
  if (!personIds(env).length && hasLegacyLayout(env)) {
    throw new PersonError("there's a profile from before several people were supported. Move it into its owner's folder first with `ojs person migrate <name>`.");
  }
  await createPersonFolders(id, name.trim(), env, now);
  await usePerson(id, env);
  return { id, name: name.trim(), active: true, searches: [] };
}

export async function usePerson(id: string, env?: Env): Promise<PersonInfo> {
  const ids = personIds(env);
  const want = ids.includes(id) ? id : ids.find((x) => x === slugify(id));
  if (!want) throw new PersonError(`no one called "${id}" here. ${ids.length ? `People: ${ids.join(", ")}` : "Add someone with `ojs person add <name>`."}`);
  const state = readActive(env);
  await writeActive({ ...state, person: want }, env);
  return { id: want, name: await personName(want, env), active: true, searches: searchIds(env, want) };
}

export async function listSearches(env?: Env, person = activePerson(env)): Promise<SearchInfo[]> {
  const active = activeSearchOrUndefined(env, person);
  const out: SearchInfo[] = [];
  for (const id of searchIds(env, person)) {
    let data: Pick<SearchData, "name" | "targetRoles"> = { name: id, targetRoles: [] };
    try {
      data = await loadSearch(join(searchesDir(env, person), id));
    } catch {
      // a broken search.yaml still shows up, by id; `search show` reports the problem
    }
    out.push({ id, name: data.name, targetRoles: data.targetRoles, active: id === active });
  }
  return out;
}

function activeSearchOrUndefined(env: Env | undefined, person: string): string | undefined {
  try {
    return activeSearch(env, person);
  } catch {
    return undefined;
  }
}

/** Start a new search for the active person, and make it the active one. */
export async function addSearch(name: string, opts: { targetRoles?: string[] } = {}, env?: Env): Promise<SearchInfo> {
  const person = activePerson(env);
  const id = idFor(name, "search");
  const dir = join(searchesDir(env, person), id);
  if (existsSync(dir)) throw new PersonError(`${person} already has a search called "${id}". Use \`ojs search use ${id}\`.`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeProfileText(dir, SEARCH_FILE, searchYamlTemplate(name.trim(), opts.targetRoles ?? []), "create");
  await useSearch(id, env);
  return { id, name: name.trim(), targetRoles: opts.targetRoles ?? [], active: true };
}

export async function useSearch(id: string, env?: Env): Promise<SearchInfo> {
  const person = activePerson(env);
  const ids = searchIds(env, person);
  const want = ids.includes(id) ? id : ids.find((x) => x === slugify(id));
  if (!want) throw new PersonError(`${person} has no search called "${id}". ${ids.length ? `Searches: ${ids.join(", ")}` : "Add one with `ojs search add <name>`."}`);
  const state = readActive(env);
  await writeActive({ ...state, search: { ...state.search, [person]: want } }, env);
  const data = await loadSearch(join(searchesDir(env, person), want));
  return { id: want, name: data.name, targetRoles: data.targetRoles, active: true };
}

export interface MigrateResult {
  person: PersonInfo;
  /** What moved, relative to the workspace. */
  moved: { from: string; to: string }[];
  /** Set when preferences in profile.yaml had something in them and became a search. */
  search?: SearchInfo;
}

/**
 * Move a profile from before people existed (data/profile/, documents/*)
 * into a person's folders. A plain move, so history and undo carry over.
 * Preferences and positioning leave profile.yaml: anything filled in becomes
 * that person's first search.
 */
export async function migrateLegacy(name: string, env?: Env, now = new Date()): Promise<MigrateResult> {
  if (!hasLegacyLayout(env)) throw new PersonError("nothing to migrate: there's no data/profile/ from before people were supported.");
  const id = idFor(name, "person");
  if (existsSync(join(dataRoot(env), id))) throw new PersonError(`there's already a folder for "${id}" in data/. Pick another name.`);
  const people = personIds(env);

  const moved: MigrateResult["moved"] = [];
  const move = async (from: string, to: string) => {
    await mkdir(join(to, ".."), { recursive: true, mode: 0o700 });
    await rename(from, to);
    const root = join(dataRoot(env), "..");
    moved.push({ from: from.slice(root.length + 1), to: to.slice(root.length + 1) });
  };

  const data = dataRoot(env);
  await mkdir(join(data, id), { recursive: true, mode: 0o700 });
  for (const item of ["profile", "flow.json", "cache"]) {
    if (existsSync(join(data, item))) await move(join(data, item), join(data, id, item));
  }
  const docs = documentsRoot(env);
  const skip = new Set(["README.md", id, ...people]);
  let entries: string[] = [];
  try {
    entries = await readdir(docs);
  } catch {
    // no documents/
  }
  for (const entry of entries) {
    if (skip.has(entry) || entry.startsWith(".")) continue;
    await move(join(docs, entry), join(docs, id, entry));
  }
  await createPersonFolders(id, name.trim(), env, now);
  await usePerson(id, env);

  const result: MigrateResult = { person: { id, name: name.trim(), active: true, searches: [] }, moved };
  const profileDir = join(data, id, "profile");
  const yamlPath = join(profileDir, PROFILE_FILE);
  if (existsSync(yamlPath)) {
    const text = await readFile(yamlPath, "utf8");
    const doc = parseDocument(text);
    const prefs = (doc.get("preferences") as { toJSON?: () => unknown } | undefined)?.toJSON?.() as Record<string, unknown> | undefined;
    const positioning = (doc.get("positioning") as { toJSON?: () => unknown } | undefined)?.toJSON?.() as { targetTitles?: string[]; theyBuy?: string; leadWith?: string[] }[] | undefined;
    if (prefs?.noticePeriod && !doc.getIn(["eligibility", "noticePeriod"])) doc.setIn(["eligibility", "noticePeriod"], prefs.noticePeriod);
    const filled = (v: unknown): boolean =>
      Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.values(v).some(filled) : v !== null && v !== undefined && v !== "";
    const { noticePeriod: _n, ...rest } = prefs ?? {};
    if (filled(rest) || filled(positioning)) {
      const targetRoles = [...((rest.targetRoles as string[] | undefined) ?? []), ...(positioning ?? []).flatMap((p) => p.targetTitles ?? [])];
      result.search = await addSearch(targetRoles[0] ?? "My search", { targetRoles: [...new Set(targetRoles)] }, env);
      const searchPath = join(searchesDir(env, id), result.search.id);
      const sdoc = parseDocument(await readFile(join(searchPath, SEARCH_FILE), "utf8"));
      for (const [k, v] of Object.entries(rest)) if (k !== "targetRoles" && filled(v)) sdoc.set(k, v);
      const angle = positioning?.[0];
      if (angle?.theyBuy) sdoc.setIn(["angle", "theyBuy"], angle.theyBuy);
      if (angle?.leadWith?.length) sdoc.setIn(["angle", "leadWith"], angle.leadWith);
      await writeProfileText(searchPath, SEARCH_FILE, sdoc.toString(), "migrate from profile.yaml");
      result.person.searches = [result.search.id];
    }
    if (doc.has("preferences") || doc.has("positioning")) {
      doc.delete("preferences");
      doc.delete("positioning");
      let next = doc.toString();
      if (!next.includes("searches/<search>/search.yaml")) {
        next = `${next.trimEnd()}\n\n# What you're looking for (roles, locations, salary) lives in each search:\n# data/<you>/searches/<search>/search.yaml. See \`ojs search\`.\n`;
      }
      await writeProfileText(profileDir, PROFILE_FILE, next, "migrate: preferences moved to searches");
    }
  }
  return result;
}
