import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePerson,
  activeSearch,
  addPerson,
  addSearch,
  applyUndo,
  correctProfile,
  dataRoot,
  listPeople,
  listSearches,
  loadSearch,
  migrateLegacy,
  PERSON_FILE,
  PersonError,
  planUndo,
  readHistory,
  SEARCH_FILE,
  searchDir,
  searchesDir,
  setFit,
  setTitles,
  titlesFor,
  usePerson,
  type TitlesView,
  useSearch,
} from "@ojs/core";
import { entryText } from "./profile.ts";

type Out = (human: string, data: unknown) => void;

export const PEOPLE_HELP = `People (one workspace can hold several people's job searches):
  person                      Everyone set up here, and who we're working on
  person add <name>           Set up someone new and switch to them
  person use <name>           Switch to someone
  person migrate <name>       Move a profile from before people existed into <name>'s folders

Searches (one person can look for more than one kind of job):
  search                      Their searches, and which one we're on
  search add <name>           Start a search ("Software engineering") and switch to it [--role "…" …] [--why "…" …]
  search fit                  How well the profile backs this search, and whether it's out of date
  search fit --level <l>      Save it: good | stretch | leap, [--evidence "…" …] [--gap "…" …] [--note "…"]
  search titles               The job titles to search for: core, related, open (flat titles worth
                              a look if a condition holds), and words that rule a title out
  search titles --yaml "<y>"  Save them: each list given replaces that list, null empties it, e.g.
                              --yaml "{core: [Staff Engineer], open: [{title: Member of Technical Staff, if: pay at or above target}]}"
  search use <name>           Switch to another search
  search show                 What this search is looking for
  search correct              Change search.yaml: --find "exact text" (--replace "new" | --remove) [--dry-run]
  search history / undo [n]   Changes to this search; undo previews unless --yes

  --person <name> / --search <name> work on any command, for that command only.
`;

function titlesText(v: TitlesView): string {
  if (v.empty) return `No titles yet${v.targetRoles.length ? ` (target roles: ${v.targetRoles.join(", ")})` : ""}. \`ojs search titles --yaml …\`.`;
  const t = v.titles;
  const lines: string[] = [];
  if (t.core.length) lines.push(`Core: ${t.core.join(", ")}`);
  if (t.related.length) lines.push("Related:", ...t.related.map((r) => `  ${r.title}${r.why ? ` (${r.why})` : ""}`));
  if (t.open.length) lines.push("Open, if:", ...t.open.map((o) => `  ${o.title}: if ${o.if}${o.why ? ` (${o.why})` : ""}`));
  if (t.exclude.length) lines.push(`Rules a title out: ${t.exclude.join(", ")}`);
  if (v.warnings.length) lines.push("", "To check:", ...v.warnings.map((w) => `  ! ${w}`));
  if (v.unexplained.length) lines.push("", `No reason yet: ${v.unexplained.join(", ")}`);
  return lines.join("\n");
}

export interface WorkingOn {
  person: { id: string; name: string };
  search?: { id: string; name: string };
  /** The active search's folder, or null when there's none yet. */
  searchDir: string | null;
}

function nameOf(id: string): string {
  try {
    const raw = JSON.parse(readFileSync(join(dataRoot(), id, PERSON_FILE), "utf8")) as { name?: unknown };
    return typeof raw.name === "string" && raw.name ? raw.name : id;
  } catch {
    return id;
  }
}

/** Who and which search; throws PersonError when no one is set up. */
export async function workingOn(): Promise<WorkingOn> {
  const id = activePerson();
  const s = activeSearch(undefined, id);
  if (!s) return { person: { id, name: nameOf(id) }, searchDir: null };
  const dir = join(searchesDir(undefined, id), s);
  let name = s;
  try {
    name = (await loadSearch(dir)).name;
  } catch {
    // broken search.yaml: show the id
  }
  return { person: { id, name: nameOf(id) }, search: { id: s, name }, searchDir: dir };
}

/** For every --json output: who the command acted on. Undefined when no one is set up. */
export function workingOnSummary(): { person: string; search: string | null } | undefined {
  try {
    const person = activePerson();
    let search: string | null = null;
    try {
      search = activeSearch(undefined, person) ?? null;
    } catch {
      // --search names a search that doesn't exist: the command itself reports it
    }
    return { person, search };
  } catch {
    return undefined;
  }
}

interface Flags {
  json: boolean;
  yes?: boolean;
  role?: string[];
  why?: string[];
  level?: string;
  evidence?: string[];
  gap?: string[];
  note?: string;
  yaml?: string;
  find?: string;
  replace?: string;
  remove?: boolean;
  limit?: string;
  "dry-run"?: boolean;
}

export async function personCommand(rest: string[], out: Out): Promise<void> {
  const [sub, ...args] = rest;
  const name = args.join(" ").trim();
  switch (sub) {
    case undefined:
    case "list": {
      const people = await listPeople();
      const human = people.length
        ? people.map((p) => `${p.active ? "→" : " "} ${p.name} (${p.id})${p.searches.length ? `: ${p.searches.join(", ")}` : ""}`).join("\n")
        : "No one is set up yet. `ojs person add <name>`.";
      return out(human, { people });
    }
    case "add": {
      if (!name) throw new PersonError("usage: ojs person add <name>");
      const p = await addPerson(name);
      return out(`Set up ${p.name}. Their documents go in documents/${p.id}/. Working on ${p.name} now.`, { person: p, documents: `documents/${p.id}` });
    }
    case "use": {
      if (!name) throw new PersonError("usage: ojs person use <name>");
      const p = await usePerson(name);
      return out(`Working on ${p.name} now.`, { person: p });
    }
    case "migrate": {
      if (!name) throw new PersonError("usage: ojs person migrate <name>  (whose profile it is)");
      const r = await migrateLegacy(name);
      const lines = [`Moved into ${r.person.name}'s folders:`, ...r.moved.map((m) => `  ${m.from} → ${m.to}`)];
      if (r.search) lines.push(`Preferences from profile.yaml became the search "${r.search.name}".`);
      return out(lines.join("\n"), r);
    }
    default:
      throw new PersonError(`unknown subcommand "person ${sub}". Run \`ojs help\`.`);
  }
}

export async function searchCommand(rest: string[], f: Flags, out: Out): Promise<void> {
  const [sub, ...args] = rest;
  const name = args.join(" ").trim();
  const person = activePerson();
  switch (sub) {
    case undefined:
    case "list": {
      const searches = await listSearches(undefined, person);
      const fitText = (s: (typeof searches)[number]) => (!s.fit ? "fit not assessed" : `fit: ${s.fit.level}${s.needsAssessing ? ` (${s.changesSince} profile change${s.changesSince === 1 ? "" : "s"} since)` : ""}`);
      const human = searches.length
        ? searches.map((s) => `${s.active ? "→" : " "} ${s.name} (${s.id})${s.targetRoles.length ? `: ${s.targetRoles.join(", ")}` : ""}. ${fitText(s)}`).join("\n")
        : `${nameOf(person)} has no searches yet. \`ojs search add <name>\`.`;
      return out(human, { person, searches });
    }
    case "add": {
      if (!name) throw new PersonError('usage: ojs search add <name> [--role "Backend engineer" …]');
      const s = await addSearch(name, { targetRoles: f.role ?? [], why: f.why ?? [] });
      return out(`Started the search "${s.name}" for ${nameOf(person)}, and switched to it.`, { person, search: s });
    }
    case "use": {
      if (!name) throw new PersonError("usage: ojs search use <name>");
      const s = await useSearch(name);
      return out(`Working on the search "${s.name}" now.`, { person, search: s });
    }
    case "fit": {
      if (f.level) {
        const r = await setFit({ level: f.level, evidence: f.evidence ?? [], gaps: f.gap ?? [], ...(f.note ? { note: f.note } : {}) });
        return out(`Saved: ${r.fit.level}, against profile change #${r.fit.profileChange}.`, r);
      }
      const current = (await listSearches(undefined, person)).find((s) => s.active);
      if (!current) searchDir(undefined, person); // throws the right message
      const c = current!;
      const human = !c.fit
        ? `"${c.name}": fit not assessed yet.`
        : [
            `"${c.name}": ${c.fit.level} (assessed ${c.fit.assessedAt}${c.needsAssessing ? `; the profile has ${c.changesSince} change${c.changesSince === 1 ? "" : "s"} since, so check it again` : ""})`,
            ...c.fit.evidence.map((e) => `  + ${e}`),
            ...c.fit.gaps.map((g) => `  - ${g}`),
            ...(c.fit.note ? [`  ${c.fit.note}`] : []),
          ].join("\n");
      return out(human, { search: c.id, fit: c.fit ?? null, changesSince: c.changesSince, needsAssessing: c.needsAssessing });
    }
    case "titles": {
      if (f.yaml) {
        const r = await setTitles(f.yaml);
        const changed = [...r.set, ...r.cleared.map((c) => `${c} (emptied)`)].join(", ");
        return out(`${r.history ? "Saved" : "No change to"} titles: ${changed}.\n\n${titlesText(r)}`, r);
      }
      const v = await titlesFor();
      return out(titlesText(v), v);
    }
    case "show": {
      const dir = searchDir(undefined, person);
      const data = await loadSearch(dir);
      return out(readFileSync(join(dir, SEARCH_FILE), "utf8"), { person, search: data });
    }
    case "correct": {
      const res = await correctProfile("search", { find: f.find ?? "", ...(f.replace !== undefined ? { replace: f.replace } : {}), remove: Boolean(f.remove), dryRun: Boolean(f["dry-run"]) }, searchDir(undefined, person));
      const verb = res.written ? "Changed" : "Would change";
      return out(`${verb} ${res.file}:\n${res.before.map((l) => `  - ${l}`).join("\n")}${res.after.length ? `\n${res.after.map((l) => `  + ${l}`).join("\n")}` : ""}`, res);
    }
    case "history": {
      const entries = await readHistory(searchDir(undefined, person));
      const limit = f.limit ? Math.max(1, Number(f.limit) || 20) : 20;
      const shown = entries.slice(-limit).reverse();
      return out(shown.length ? shown.map(entryText).join("\n\n") : "No changes yet.", { entries: shown, total: entries.length });
    }
    case "undo": {
      const n = args[0] ? Number(args[0].replace(/^#/, "")) : undefined;
      if (args[0] && !Number.isInteger(n)) throw new PersonError("usage: ojs search undo [n] [--yes]");
      const dir = searchDir(undefined, person);
      const plan = await planUndo(dir, n);
      if (plan.text === null) throw new PersonError(`#${plan.entry.n} created this search. To drop a search, delete its folder: ${dir}`);
      if (!f.yes) return out(`Undoing #${plan.entry.n} would put ${plan.entry.file} back as it was before:\n\n${entryText(plan.entry)}\n\nRun again with --yes to undo it.`, { undo: plan.entry.n, file: plan.entry.file, written: false });
      const done = await applyUndo(plan, dir);
      return out(`Undid #${plan.entry.n}. Logged as #${done}.`, { undo: plan.entry.n, file: plan.entry.file, written: true, history: done });
    }
    default:
      throw new PersonError(`unknown subcommand "search ${sub}". Run \`ojs help\`.`);
  }
}
