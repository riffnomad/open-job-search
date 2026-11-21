import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePerson,
  applyUndo,
  personDir,
  PersonError,
  planUndo,
  preferencesFor,
  readHistory,
  searchDir,
  setPreferences,
  USUAL_PREFERENCES_FILE,
  yamlInline,
  type PreferencesView,
} from "@ojs/core";
import { workingOn } from "./people.ts";
import { entryText } from "./profile.ts";

type Out = (human: string, data: unknown) => void;

export const PREFS_HELP = `Preferences (what someone wants from a job; step 4):
  prefs                       What this search wants: its own preferences plus their usual ones,
                              hard rules, priority weights, anything that doesn't fit, reasons still to ask
  prefs set --yaml "<yaml>"   Save preferences to this search, e.g. --yaml "workMode: [hybrid]" (null clears one)
  prefs ... --usual           Their usual preferences instead, which every search falls back on
  prefs file                  The file itself, comments and all
  prefs history / undo [n]    Changes (with --usual: to the usual ones); undo previews unless --yes
`;

interface Flags {
  yaml?: string;
  usual?: boolean;
  yes?: boolean;
  limit?: string;
}

const show = (v: unknown): string => (Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : typeof v === "string" ? v : yamlInline(v));

function render(v: PreferencesView, title: string): string {
  if (v.empty) return `${title}: nothing set yet.`;
  const p = v.preferences as Record<string, unknown>;
  const lines = [title, ""];
  for (const k of Object.keys(v.from)) {
    const from = v.from[k as keyof typeof v.from];
    const reason = v.preferences.reasons[k];
    lines.push(`  ${k}: ${show(p[k])}${from === "usual" && v.search ? "  (usual)" : from === "both" ? "  (usual + this search)" : ""}${reason ? `\n      why: ${reason}` : ""}`);
  }
  if (v.hardRules.length) lines.push("", "Rules a job out:", ...v.hardRules.map((r) => `  ✗ ${r.rule}${r.why ? ` (${r.why})` : ""}`));
  const w = Object.entries(v.weights);
  if (w.length) lines.push("", `Scoring weights: ${w.map(([k, n]) => `${k} ${Math.round(n * 100)}%`).join(", ")}`);
  if (v.warnings.length) lines.push("", "To check:", ...v.warnings.map((x) => `  ! ${x}`));
  if (v.unexplained.length) lines.push("", `No reason yet: ${v.unexplained.join(", ")}`);
  return lines.join("\n");
}

export async function prefsCommand(rest: string[], f: Flags, out: Out): Promise<void> {
  const [sub, ...args] = rest;
  const person = activePerson();
  const who = await workingOn();
  const dir = (): string => (f.usual ? personDir(undefined, person) : searchDir(undefined, person));
  switch (sub) {
    case undefined:
    case "show": {
      const searchFolder = f.usual ? null : who.searchDir;
      if (!f.usual && !searchFolder) searchDir(undefined, person); // throws the right message
      const v = await preferencesFor(personDir(undefined, person), searchFolder);
      const title = f.usual ? `${who.person.name}'s usual preferences` : `"${who.search!.name}" wants`;
      return out(render(v, title), v);
    }
    case "set": {
      if (!f.yaml) throw new PersonError('usage: ojs prefs set --yaml "workMode: [hybrid]" [--usual]');
      const r = await setPreferences(f.yaml, { usual: Boolean(f.usual) });
      const where = r.scope === "usual" ? `${who.person.name}'s usual preferences` : `"${who.search?.name ?? r.search}"`;
      const changed = [...r.set, ...r.cleared.map((c) => `${c} (cleared)`)].join(", ");
      const extra = [...r.view.warnings.map((x) => `! ${x}`)];
      return out(`${r.history ? "Saved" : "No change to"} ${where}: ${changed}.${extra.length ? `\n\n${extra.join("\n")}` : ""}`, r);
    }
    case "history": {
      const entries = await readHistory(dir());
      const file = f.usual ? USUAL_PREFERENCES_FILE : "search.yaml";
      const mine = entries.filter((e) => e.file === file);
      const limit = f.limit ? Math.max(1, Number(f.limit) || 20) : 20;
      const shown = mine.slice(-limit).reverse();
      return out(shown.length ? shown.map(entryText).join("\n\n") : "No changes yet.", { entries: shown, total: mine.length });
    }
    case "undo": {
      const n = args[0] ? Number(args[0].replace(/^#/, "")) : undefined;
      if (args[0] && !Number.isInteger(n)) throw new PersonError("usage: ojs prefs undo [n] [--usual] [--yes]");
      const d = dir();
      const plan = await planUndo(d, n);
      if (plan.text === null) throw new PersonError(`#${plan.entry.n} created ${plan.entry.file}; there's nothing before it to go back to.`);
      if (!f.yes) return out(`Undoing #${plan.entry.n} would put ${plan.entry.file} back as it was before:\n\n${entryText(plan.entry)}\n\nRun again with --yes to undo it.`, { undo: plan.entry.n, file: plan.entry.file, written: false });
      const done = await applyUndo(plan, d);
      return out(`Undid #${plan.entry.n}. Logged as #${done}.`, { undo: plan.entry.n, file: plan.entry.file, written: true, history: done });
    }
    case "file": {
      // The raw file, comments and all.
      const path = f.usual ? join(personDir(undefined, person), USUAL_PREFERENCES_FILE) : join(searchDir(undefined, person), "search.yaml");
      let text = "";
      try {
        text = readFileSync(path, "utf8");
      } catch {
        throw new PersonError(f.usual ? "no usual preferences yet: `ojs prefs set --usual --yaml …`." : `can't read ${path}`);
      }
      return out(text, { path, text });
    }
    default:
      throw new PersonError(`unknown subcommand "prefs ${sub}". Run \`ojs help\`.`);
  }
}
