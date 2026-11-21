/**
 * The path through open-job-search, one step at a time. Each step must be
 * marked done before the next one starts; the person decides when a step is
 * done (the tool only refuses when there's nothing there at all).
 *
 * Progress is kept in data/flow.json, so a new session, or a different
 * agent, carries on where the last one stopped.
 *
 * Steps 1 and 2 are discovery: learn as much as possible about the person
 * before looking at any job.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir, documentsDir, profileDir } from "./paths.ts";
import { findGaps } from "./profile/gaps.ts";
import { listDocuments } from "./profile/import.ts";
import { loadProfile } from "./profile/load.ts";
import { sectionBullets } from "./profile/role-file.ts";

export const FLOW_FILE = "flow.json";

export interface FlowStepInfo {
  id: string;
  n: number;
  title: string;
  /** One line on what the step is for, for the person. */
  about: string;
  /** The skills an agent follows for this step, in .agents/skills/. */
  skills: string[];
}

export const FLOW_STEPS: readonly FlowStepInfo[] = [
  {
    id: "experience",
    n: 1,
    title: "Your experience",
    about: "Your CV, then everything it left out: role by role, projects, results, hard moments, stories.",
    skills: ["import-cv", "dig"],
  },
  {
    id: "past-lives",
    n: 2,
    title: "Past lives",
    about: "Other jobs you've had, before or alongside your career, and the skills and stories they gave you.",
    skills: ["past-lives", "dig"],
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Where the person is, and what each step has so far. */
export async function flowStatus(opts: { data?: string; profile?: string; documents?: string } = {}): Promise<FlowStatus> {
  const data = opts.data ?? dataDir();
  const profDir = opts.profile ?? (opts.data ? join(data, "profile") : profileDir());
  const docsDir = opts.documents ?? (opts.data ? join(data, "..", "documents") : documentsDir());
  const state = await readState(data);
  const profile = await loadProfile(profDir);
  const docs = await listDocuments(docsDir, profDir);

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
      progress.push(profile.pastLives.length ? `${plural(profile.pastLives.length, "past life")}, ${dugLives.length} dug into` : "No past lives yet (that's fine if there aren't any)");
      for (const { p } of reports.lives) if (!dug(p.doc)) suggestions.push(`Dig into ${p.doc.frontMatter.field} (${p.file})`);
      const stillToAsk = reports.lives.reduce((n, { g }) => n + g.depth.stillToAsk, 0);
      if (stillToAsk) suggestions.push(`${plural(stillToAsk, "question")} saved under "Still to ask"`);
    }

    const doneAt = state.done[info.id];
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
export async function markStepDone(id: string, opts: { data?: string; profile?: string; documents?: string; now?: Date } = {}): Promise<FlowStatus> {
  const data = opts.data ?? dataDir();
  const step = findStep(id);
  const status = await flowStatus({ ...opts, data });
  const s = status.steps.find((x) => x.id === step.id)!;
  if (s.state === "done") throw new FlowError(`step ${s.n} (${s.title}) is already done.`);
  if (s.state === "locked") throw new FlowError(s.blockers.join(" "));
  if (s.blockers.length) throw new FlowError(`step ${s.n} (${s.title}) can't be marked done yet: ${s.blockers.join(" ")}`);
  const state = await readState(data);
  state.done[step.id] = (opts.now ?? new Date()).toISOString();
  await writeState(data, state);
  return flowStatus({ ...opts, data });
}

/** Go back to a step: it and every step after it become not done. */
export async function reopenStep(id: string, opts: { data?: string } = {}): Promise<string[]> {
  const data = opts.data ?? dataDir();
  const step = findStep(id);
  const state = await readState(data);
  const reopened = FLOW_STEPS.filter((s) => s.n >= step.n && state.done[s.id]).map((s) => s.id);
  for (const r of reopened) delete state.done[r];
  await writeState(data, state);
  return reopened;
}
