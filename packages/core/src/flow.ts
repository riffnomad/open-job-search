/**
 * The path through open-job-search, one step at a time. Each step must be
 * marked done before the next one starts; the person decides when a step is
 * done (the tool only refuses when there's nothing there at all).
 *
 * Progress is kept per person (data/<person>/flow.json), so a new session,
 * or a different agent, carries on where the last one stopped. Steps about
 * a search (scope "search") are kept in that search's own flow.json: a
 * second search starts those steps afresh, and never repeats discovery.
 *
 * Steps 1 and 2 are discovery: learn as much as possible about the person
 * before looking at any job. Step 3 turns that into searches; step 4 is done
 * for each search.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { documentsDir, personDir } from "./paths.ts";
import { findGaps } from "./profile/gaps.ts";
import { listDocuments } from "./profile/import.ts";
import { loadProfile } from "./profile/load.ts";
import { sectionBullets } from "./profile/role-file.ts";
import { preferencesFor, searchSummaries } from "./people.ts";

export const FLOW_FILE = "flow.json";

export interface FlowStepInfo {
  id: string;
  n: number;
  title: string;
  /** One line on what the step is for, for the person. */
  about: string;
  /** The skills an agent follows for this step, in .agents/skills/. */
  skills: string[];
  /** "person": done once per person. "search": done for each of their searches. */
  scope: "person" | "search";
}

export const FLOW_STEPS: readonly FlowStepInfo[] = [
  {
    id: "experience",
    n: 1,
    title: "Your experience",
    about: "Your CV, then everything it left out: role by role, projects, results, hard moments, stories.",
    skills: ["import-cv", "dig"],
    scope: "person",
  },
  {
    id: "past-lives",
    n: 2,
    title: "Past lives",
    about: "Other jobs you've had, before or alongside your career, and the skills and stories they gave you.",
    skills: ["past-lives", "dig"],
    scope: "person",
  },
  {
    id: "targets",
    n: 3,
    title: "Roles to aim for",
    about: "What you want to look for and why, how well your profile backs it, and how many searches that makes.",
    skills: ["targets"],
    scope: "person",
  },
  {
    id: "preferences",
    n: 4,
    title: "What you want from the job",
    about: "Where and how you want to work, pay, the kind of company, what rules a job out, and what matters most. With the reason for each.",
    skills: ["preferences"],
    scope: "search",
  },
] as const;

export class FlowError extends Error {
  override name = "FlowError";
}

interface FlowState {
  version: 1;
  done: Record<string, string>;
}

export interface FlowStepStatus extends FlowStepInfo {
  state: "done" | "current" | "locked";
  doneAt?: string;
  /** What's there so far, in plain words. */
  progress: string[];
  /** What could still be added. Not required: the person decides when a step is done. */
  suggestions: string[];
  /** Why the step can't be marked done yet, if anything. */
  blockers: string[];
}

export interface FlowStatus {
  current?: string;
  steps: FlowStepStatus[];
  /** True when every step so far is done. More steps are coming. */
  complete: boolean;
}

function flowPath(dir: string): string {
  return join(dir, FLOW_FILE);
}

async function readState(dir: string): Promise<FlowState> {
  try {
    const raw = JSON.parse(await readFile(flowPath(dir), "utf8")) as Partial<FlowState>;
    return { version: 1, done: raw.done && typeof raw.done === "object" ? raw.done : {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, done: {} };
    throw new FlowError(`${flowPath(dir)} is not valid JSON: ${(err as Error).message}`);
  }
}

async function writeState(dir: string, state: FlowState): Promise<void> {
  const path = flowPath(dir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export interface FlowOptions {
  /** The person's folder, data/<person>/. Defaults to the active person. */
  person?: string;
  /** Defaults to <person>/profile. */
  profile?: string;
  /** Defaults to the active person's documents/<person>/. */
  documents?: string;
  /** The active search's folder, or null when they have none yet. Only read by search steps. */
  search?: string | null;
}

/** Where the person is, and what each step has so far. */
export async function flowStatus(opts: FlowOptions = {}): Promise<FlowStatus> {
  const person = opts.person ?? personDir();
  const profDir = opts.profile ?? join(person, "profile");
  const docsDir = opts.documents ?? documentsDir();
  const states = {
    person: await readState(person),
    search: opts.search ? await readState(opts.search) : ({ version: 1, done: {} } as FlowState),
  };
  const profile = await loadProfile(profDir);
  const docs = await listDocuments(docsDir, profDir);

  const searches = await searchSummaries(person);
  const reports = {
    roles: profile.roles.map((r) => ({ r, g: findGaps(r.doc) })),
    lives: profile.pastLives.map((p) => ({ p, g: findGaps(p.doc) })),
  };
  const dug = (doc: { sections: { raw: string; heading: string; headingLine: string }[] }) =>
    doc.sections.some((s) => sectionBullets(s).some((b) => b.source.kind === "dig"));

  const steps: FlowStepStatus[] = [];
  let current: string | undefined;
  for (const info of FLOW_STEPS) {
    const progress: string[] = [];
    const suggestions: string[] = [];
    const blockers: string[] = [];

    if (info.id === "experience") {
      const pending = docs.filter((d) => d.status !== "imported");
      const dugRoles = reports.roles.filter(({ r }) => dug(r.doc));
      const toConfirm = reports.roles.reduce((n, { g }) => n + g.depth.toConfirm, 0);
      const stillToAsk = reports.roles.reduce((n, { g }) => n + g.depth.stillToAsk, 0);
      const lines = reports.roles.reduce((n, { g }) => n + g.depth.bullets, 0);
      progress.push(`${plural(profile.roles.length, "role")}, ${plural(lines, "line")} of experience`, `${dugRoles.length} of ${profile.roles.length} roles dug into`);
      if (pending.length) suggestions.push(`Import ${pending.map((d) => d.file).join(", ")} (new or changed in documents/)`);
      for (const { r } of reports.roles) if (!dug(r.doc)) suggestions.push(`Dig into ${r.doc.frontMatter.employer} (${r.file})`);
      if (toConfirm) suggestions.push(`Confirm or reject ${plural(toConfirm, "guess")} under "To confirm"`);
      if (stillToAsk) suggestions.push(`${plural(stillToAsk, "question")} saved under "Still to ask"`);
      if (!profile.roles.length) blockers.push("No roles yet: import a CV or add a role first.");
    } else if (info.id === "past-lives") {
      const dugLives = reports.lives.filter(({ p }) => dug(p.doc));
      progress.push(profile.pastLives.length ? `${plural(profile.pastLives.length, "past life", "past lives")}, ${dugLives.length} dug into` : "No past lives yet (that's fine if there aren't any)");
      for (const { p } of reports.lives) if (!dug(p.doc)) suggestions.push(`Dig into ${p.doc.frontMatter.field} (${p.file})`);
      const stillToAsk = reports.lives.reduce((n, { g }) => n + g.depth.stillToAsk, 0);
      if (stillToAsk) suggestions.push(`${plural(stillToAsk, "question")} saved under "Still to ask"`);
    } else if (info.id === "targets") {
      progress.push(searches.length ? `${plural(searches.length, "search", "searches")}: ${searches.map((x) => x.name).join(", ")}` : "No searches yet");
      for (const x of searches) {
        if (!x.targetRoles.length) suggestions.push(`Add target roles to "${x.name}"`);
        if (!x.why.length) suggestions.push(`Ask why they want "${x.name}"`);
        if (!x.fit) suggestions.push(`Assess how well the profile backs "${x.name}"`);
        else if (x.needsAssessing) suggestions.push(`"${x.name}": the profile has ${plural(x.changesSince, "change")} since its fit was assessed; check it again`);
      }
      if (!searches.length) blockers.push("No searches yet: decide what to look for first.");
    } else if (info.id === "preferences" && opts.search) {
      const v = await preferencesFor(person, opts.search);
      const p = v.preferences;
      const set = Object.keys(v.from);
      const usual = set.filter((k) => v.from[k as keyof typeof v.from] === "usual").length;
      progress.push(set.length ? `${plural(set.length, "preference")} set${usual ? ` (${usual} from their usual ones)` : ""}` : "Nothing set yet");
      if (p.priorities.length) progress.push(`Priorities: ${p.priorities.join(", ")}`);
      if (v.hardRules.length) progress.push(`${plural(v.hardRules.length, "hard rule")}: ${v.hardRules.map((r) => r.rule).join("; ")}`);
      if (!p.workMode.length && !p.locations.length) suggestions.push("Where and how they want to work (remote, hybrid, office; places)");
      if (!p.salary) suggestions.push("Talk about pay: their current package, then a minimum, a target and an opening ask");
      else if (!p.salary.min) suggestions.push("Agree a salary minimum: the walk-away number");
      if (!p.priorities.length) suggestions.push("Put what matters most in order (pay, flexibility, growth, …)");
      if (!p.dealBreakers.length) suggestions.push("Ask if anything would rule a job out");
      if (v.unexplained.length) suggestions.push(`Ask why: ${v.unexplained.join(", ")}`);
      for (const w of v.warnings) suggestions.push(`Check: ${w}`);
      if (v.empty) blockers.push("Nothing saved for this search yet: `ojs prefs set`.");
    }

    if (info.scope === "search") {
      if (!opts.search) blockers.push(searches.length ? "Choose which search to work on: `ojs search use <name>`." : "Needs a search first: `ojs search add <name>`.");
      // Search steps are done per search: name the other searches still waiting on this one.
      const waiting: string[] = [];
      for (const x of searches) {
        const dir = join(person, "searches", x.id);
        if (dir !== opts.search && !(await readState(dir)).done[info.id]) waiting.push(x.name);
      }
      if (waiting.length) progress.push(`Other searches still to do: ${waiting.join(", ")}`);
    }
    const doneAt = states[info.scope].done[info.id];
    let stepState: FlowStepStatus["state"];
    if (doneAt) stepState = "done";
    else if (!current) {
      stepState = "current";
      current = info.id;
    } else stepState = "locked";
    if (stepState === "locked") blockers.push(`Step ${FLOW_STEPS.find((s) => s.id === current)!.n} comes first.`);
    steps.push({ ...info, state: stepState, ...(doneAt ? { doneAt } : {}), progress, suggestions, blockers });
  }
  return { ...(current ? { current } : {}), steps, complete: !current };
}

function findStep(id: string): FlowStepInfo {
  const want = id.trim().toLowerCase();
  const step = FLOW_STEPS.find((s) => s.id === want || String(s.n) === want);
  if (!step) throw new FlowError(`no step "${id}". Steps: ${FLOW_STEPS.map((s) => `${s.n} ${s.id}`).join(", ")}`);
  return step;
}

/** Mark the current step done, when the person says so. Steps go in order. */
export async function markStepDone(id: string, opts: FlowOptions & { now?: Date } = {}): Promise<FlowStatus> {
  const person = opts.person ?? personDir();
  const step = findStep(id);
  const status = await flowStatus({ ...opts, person });
  const s = status.steps.find((x) => x.id === step.id)!;
  if (s.state === "done") throw new FlowError(`step ${s.n} (${s.title}) is already done.`);
  if (s.state === "locked") throw new FlowError(s.blockers.join(" "));
  if (s.blockers.length) throw new FlowError(`step ${s.n} (${s.title}) can't be marked done yet: ${s.blockers.join(" ")}`);
  const dir = step.scope === "search" ? opts.search! : person;
  const state = await readState(dir);
  state.done[step.id] = (opts.now ?? new Date()).toISOString();
  await writeState(dir, state);
  return flowStatus({ ...opts, person });
}

/** Go back to a step: it and every step after it become not done. */
export async function reopenStep(id: string, opts: { person?: string; search?: string | null } = {}): Promise<string[]> {
  const step = findStep(id);
  const reopened: string[] = [];
  for (const [scope, dir] of [["person", opts.person ?? personDir()], ["search", opts.search]] as const) {
    if (!dir) continue;
    const state = await readState(dir);
    const ids = FLOW_STEPS.filter((s) => s.scope === scope && s.n >= step.n && state.done[s.id]).map((s) => s.id);
    if (!ids.length) continue;
    for (const r of ids) delete state.done[r];
    await writeState(dir, state);
    reopened.push(...ids);
  }
  return reopened;
}
