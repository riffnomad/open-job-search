/**
 * People and their searches. One workspace can hold several people (you, and
 * someone whose search you're running for them), and each person can run
 * several searches. See paths.ts for the layout.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
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
  SEARCHES_DIR,
  searchesDir,
  searchIds,
  type ActiveState,
} from "./paths.ts";
import { slugify } from "./profile/role-file.ts";
import { ensureProfileDirs, writeProfileText } from "./profile/store.ts";
import { PROFILE_FILE } from "./profile/load.ts";
import { readHistory } from "./profile/history.ts";
import { checkTitles, emptyTitles, TITLE_LISTS, Titles, titlesEmpty, titlesUnexplained, type TitleList } from "./titles.ts";
import { FIT_LEVELS, fitStatus, loadSearch, loadUsualPreferences, parseSearchYaml, parseUsualPreferences, searchYamlTemplate, type FitLevel, type FitStatus, type SearchData } from "./search.ts";
import {
  checkPreferences,
  effectivePreferences,
  hardRules,
  PREFERENCE_KEYS,
  priorityWeights,
  setTopLevelKey,
  unexplained,
  USUAL_PREFERENCES_FILE,
  usualPreferencesTemplate,
  type EffectivePreferences,
  type HardRule,
  type PreferenceKey,
  type Preferences,
} from "./preferences.ts";

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

export interface SearchSummary extends SearchInfo, FitStatus {
  why: string[];
  titles?: Titles;
}

/** The latest entry in a person's profile history: what a fit assessment is stamped with. */
export async function latestProfileChange(env?: Env, person = activePerson(env)): Promise<number> {
  return (await readHistory(join(personDirOf(env, person), "profile"))).at(-1)?.n ?? 0;
}

function personDirOf(env: Env | undefined, person: string): string {
  return join(dataRoot(env), person);
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

export async function listSearches(env?: Env, person = activePerson(env)): Promise<SearchSummary[]> {
  return searchSummaries(personDirOf(env, person), activeSearchOrUndefined(env, person));
}

/** Every search in a person's folder (data/<person>/), with why and whether its fit is current. */
export async function searchSummaries(personFolder: string, activeId?: string): Promise<SearchSummary[]> {
  const latest = (await readHistory(join(personFolder, "profile"))).at(-1)?.n ?? 0;
  const root = join(personFolder, SEARCHES_DIR);
  let ids: string[] = [];
  try {
    ids = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && existsSync(join(root, d.name, SEARCH_FILE))).map((d) => d.name).sort();
  } catch {
    // no searches yet
  }
  const out: SearchSummary[] = [];
  for (const id of ids) {
    let data: Pick<SearchData, "name" | "targetRoles" | "why" | "fit" | "titles"> = { name: id, targetRoles: [], why: [] };
    try {
      data = await loadSearch(join(root, id));
    } catch {
      // a broken search.yaml still shows up, by id; `search show` reports the problem
    }
    out.push({ id, name: data.name, targetRoles: data.targetRoles, why: data.why, ...(data.titles ? { titles: data.titles } : {}), active: id === activeId, ...fitStatus(data, latest) });
  }
  return out;
}

export interface FitInput {
  level: string;
  evidence?: string[];
  gaps?: string[];
  note?: string;
}

/** Save how well the profile backs the active search, replacing any earlier assessment. */
export async function setFit(input: FitInput, env?: Env, now = new Date()): Promise<{ search: string; fit: NonNullable<SearchData["fit"]>; history?: number }> {
  const person = activePerson(env);
  const id = activeSearch(env, person);
  if (!id) throw new PersonError(searchIds(env, person).length ? "more than one search: choose one with `ojs search use <name>`, or pass --search." : "no search yet: `ojs search add <name>` first.");
  if (!(FIT_LEVELS as readonly string[]).includes(input.level)) throw new PersonError(`--level must be one of: ${FIT_LEVELS.join(", ")}`);
  const fit = {
    level: input.level as FitLevel,
    evidence: (input.evidence ?? []).map((e) => e.trim()).filter(Boolean),
    gaps: (input.gaps ?? []).map((g) => g.trim()).filter(Boolean),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    assessedAt: now.toISOString().slice(0, 10),
    profileChange: await latestProfileChange(env, person),
  };
  const dir = join(searchesDir(env, person), id);
  // Only the fit lines change: comments and the rest of the file stay as they are.
  const text = setTopLevelKey(await readFile(join(dir, SEARCH_FILE), "utf8"), "fit", fit, { block: true, afterComment: "# fit:", before: "seniority" });
  parseSearchYaml(text);
  const history = await writeProfileText(dir, SEARCH_FILE, text, "fit");
  return { search: id, fit, ...(history ? { history } : {}) };
}

export interface TitlesView {
  search: string;
  targetRoles: string[];
  titles: Titles;
  empty: boolean;
  warnings: string[];
  /** Related and open titles with no reason yet. */
  unexplained: string[];
}

export function titlesView(search: string, data: Pick<SearchData, "targetRoles" | "titles">): TitlesView {
  const titles = data.titles ?? emptyTitles();
  return { search, targetRoles: data.targetRoles, titles, empty: titlesEmpty(titles), warnings: checkTitles(titles), unexplained: titlesUnexplained(titles) };
}

function requireActiveSearch(env: Env | undefined, person: string): string {
  const id = activeSearch(env, person);
  if (!id) throw new PersonError(searchIds(env, person).length ? "more than one search: choose one with `ojs search use <name>`, or pass --search." : "no search yet: `ojs search add <name>` first.");
  return id;
}

/**
 * Save titles to the active search. Each list given replaces that list;
 * null empties it; lists not given stay as they are.
 */
export async function setTitles(input: string, env?: Env): Promise<TitlesView & { set: TitleList[]; cleared: TitleList[]; history?: number }> {
  const person = activePerson(env);
  const id = requireActiveSearch(env, person);
  let raw: unknown;
  try {
    raw = parseYaml(input);
  } catch (err) {
    throw new PersonError(`--yaml isn't valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PersonError('--yaml must be a mapping, e.g. "{core: [Staff Engineer], exclude: [Junior]}"');
  const given = raw as Record<string, unknown>;
  const unknown = Object.keys(given).filter((k) => !(TITLE_LISTS as readonly string[]).includes(k));
  if (unknown.length) throw new PersonError(`not a title list: ${unknown.join(", ")}. Lists: ${TITLE_LISTS.join(", ")}`);
  const dir = join(searchesDir(env, person), id);
  const path = join(dir, SEARCH_FILE);
  const current = parseSearchYaml(await readFile(path, "utf8"), path);
  const merged: Record<string, unknown> = { ...(current.titles ?? emptyTitles()) };
  const set: TitleList[] = [];
  const cleared: TitleList[] = [];
  for (const k of TITLE_LISTS) {
    if (!(k in given)) continue;
    if (given[k] === null) {
      merged[k] = [];
      cleared.push(k);
    } else {
      merged[k] = given[k];
      set.push(k);
    }
  }
  const parsed = Titles.safeParse(merged);
  if (!parsed.success) throw new PersonError(`those titles aren't valid, so nothing was saved:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  // Saved compactly: empty lists left out, plain related titles as strings.
  const t = parsed.data;
  const compact: Record<string, unknown> = {};
  for (const k of TITLE_LISTS) {
    if (!t[k].length) continue;
    compact[k] = k === "related" ? t.related.map((r) => (r.why ? r : r.title)) : t[k];
  }
  const text = setTopLevelKey(await readFile(path, "utf8"), "titles", Object.keys(compact).length ? compact : null, { block: true, afterComment: "# titles:", beforeComment: "# fit:" });
  const data = parseSearchYaml(text, path);
  const history = await writeProfileText(dir, SEARCH_FILE, text, `titles: ${[...set, ...cleared.map((c) => `-${c}`)].join(", ")}`);
  return { ...titlesView(id, data), set, cleared, ...(history ? { history } : {}) };
}

/** The active search's titles. */
export async function titlesFor(env?: Env): Promise<TitlesView> {
  const person = activePerson(env);
  const id = requireActiveSearch(env, person);
  return titlesView(id, await loadSearch(join(searchesDir(env, person), id)));
}

function activeSearchOrUndefined(env: Env | undefined, person: string): string | undefined {
  try {
    return activeSearch(env, person);
  } catch {
    return undefined;
  }
}

/** Start a new search for the active person, and make it the active one. */
export async function addSearch(name: string, opts: { targetRoles?: string[]; why?: string[] } = {}, env?: Env): Promise<SearchInfo> {
  const person = activePerson(env);
  const id = idFor(name, "search");
  const dir = join(searchesDir(env, person), id);
  if (existsSync(dir)) throw new PersonError(`${person} already has a search called "${id}". Use \`ojs search use ${id}\`.`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeProfileText(dir, SEARCH_FILE, searchYamlTemplate(name.trim(), opts.targetRoles ?? [], opts.why ?? []), "create");
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

export interface PreferencesView {
  /** The search these are for, or null for the person's usual preferences alone. */
  search: string | null;
  /** What the search actually uses: its own preferences, else the person's usual ones. */
  preferences: Preferences;
  from: EffectivePreferences["from"];
  /** What rules a job out completely. */
  hardRules: HardRule[];
  /** Scoring weights from the order of priorities. */
  weights: Record<string, number>;
  /** Things that don't fit together, to raise gently. */
  warnings: string[];
  /** Preferences that are set but have no reason yet. */
  unexplained: PreferenceKey[];
  /** True when nothing at all is set, in the search or the usual preferences. */
  empty: boolean;
}

/** The preferences a search uses (or the usual ones alone, with no search), with what to check. */
export async function preferencesFor(personFolder: string, searchFolder: string | null): Promise<PreferencesView> {
  const usual = await loadUsualPreferences(personFolder);
  const search = searchFolder ? await loadSearch(searchFolder) : undefined;
  const { preferences, from } = effectivePreferences(usual, search ?? {});
  return {
    search: searchFolder ? basename(searchFolder) : null,
    preferences,
    from,
    hardRules: hardRules(preferences),
    weights: priorityWeights(preferences.priorities),
    warnings: checkPreferences(preferences),
    unexplained: unexplained(preferences),
    empty: !Object.keys(from).length && !Object.keys(preferences.reasons).length,
  };
}

export interface SetPreferencesResult {
  /** "search" (this search's search.yaml) or "usual" (the person's preferences.yaml). */
  scope: "search" | "usual";
  search?: string;
  file: string;
  set: string[];
  cleared: string[];
  history?: number;
  view: PreferencesView;
}

/**
 * Save preferences, given as a YAML (or JSON) mapping of preference to value:
 * `workMode: [hybrid]`, `salary: { min: 60000 }`. Each one given replaces what
 * was there; null clears it. Into the active search, or with `usual`, into
 * the person's usual preferences, which every search falls back on.
 */
export async function setPreferences(input: string, opts: { usual?: boolean } = {}, env?: Env): Promise<SetPreferencesResult> {
  let values: unknown;
  try {
    values = parseYaml(input);
  } catch (err) {
    throw new PersonError(`--yaml isn't valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new PersonError('--yaml must be a mapping of preference to value, e.g. "workMode: [hybrid]"');
  const keys = Object.keys(values);
  if (!keys.length) throw new PersonError("--yaml has no preferences in it.");
  const unknown = keys.filter((k) => !(PREFERENCE_KEYS as string[]).includes(k));
  if (unknown.length) throw new PersonError(`not a preference: ${unknown.join(", ")}. Preferences: ${PREFERENCE_KEYS.join(", ")}`);

  const person = activePerson(env);
  const folder = personDirOf(env, person);
  let dir: string;
  let file: string;
  let search: string | undefined;
  if (opts.usual) {
    [dir, file] = [folder, USUAL_PREFERENCES_FILE];
    if (!existsSync(join(dir, file))) await writeProfileText(dir, file, usualPreferencesTemplate(), "create");
  } else {
    search = activeSearch(env, person);
    if (!search) {
      throw new PersonError(
        searchIds(env, person).length
          ? "more than one search: choose one with `ojs search use <name>` or pass --search, or use --usual for preferences that hold for all of them."
          : "no search yet: `ojs search add <name>` first, or use --usual for their usual preferences.",
      );
    }
    [dir, file] = [join(searchesDir(env, person), search), SEARCH_FILE];
  }

  let text = await readFile(join(dir, file), "utf8");
  const set: string[] = [];
  const cleared: string[] = [];
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    text = setTopLevelKey(text, k, v, opts.usual ? {} : { before: "angle" });
    (v === null ? cleared : set).push(k);
  }
  try {
    if (opts.usual) parseUsualPreferences(text, file);
    else parseSearchYaml(text, file);
  } catch (err) {
    throw new PersonError(`those preferences aren't valid, so nothing was saved: ${(err as Error).message}`);
  }
  const action = `prefs: ${[...set, ...cleared.map((c) => `-${c}`)].join(", ")}`;
  const history = await writeProfileText(dir, file, text, action);
  const active = opts.usual ? activeSearchOrUndefined(env, person) : search;
  const view = await preferencesFor(folder, active ? join(searchesDir(env, person), active) : null);
  return { scope: opts.usual ? "usual" : "search", ...(search ? { search } : {}), file, set, cleared, ...(history ? { history } : {}), view };
}
