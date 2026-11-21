import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchDir } from "../src/paths.ts";
import { addPerson, addSearch, preferencesFor, setFit, setPreferences } from "../src/people.ts";
import { checkPreferences, effectivePreferences, hardRules, Preferences, priorityWeights, setTopLevelKey, unexplained } from "../src/preferences.ts";
import { readHistory } from "../src/profile/history.ts";

const prefs = (p: Record<string, unknown>) => Preferences.parse(p);

describe("preferences", () => {
  test("a search uses its own preferences, else the usual ones; deal-breakers add up", () => {
    const usual = prefs({ locations: ["London"], workMode: ["remote"], dealBreakers: [{ rule: "No on-call", why: "Burnt out" }], reasons: { workMode: "School pickup" } });
    const search = prefs({ workMode: ["hybrid"], dealBreakers: ["No agencies", "no on-call"], reasons: { workMode: "Wants a team around" } });
    const { preferences: p, from } = effectivePreferences(usual, search);
    expect(p.locations).toEqual(["London"]);
    expect(p.workMode).toEqual(["hybrid"]);
    expect(p.dealBreakers).toEqual([{ rule: "No agencies" }, { rule: "no on-call" }]);
    expect(p.reasons.workMode).toBe("Wants a team around");
    expect(from).toEqual({ locations: "usual", workMode: "search", dealBreakers: "both" });
  });

  test("hard rules: deal-breakers and the salary minimum", () => {
    const p = prefs({ dealBreakers: [{ rule: "No on-call", why: "Burnt out" }], salary: { min: 60000 }, reasons: { salary: "Mortgage" } });
    expect(hardRules(p)).toEqual([
      { rule: "No on-call", why: "Burnt out" },
      { rule: "Pay at least 60,000 GBP a year", why: "Mortgage" },
    ]);
  });

  test("priority order becomes weights that add to 1", () => {
    expect(priorityWeights(["Pay", "flexibility", "growth"])).toEqual({ pay: 0.5, flexibility: 0.33, growth: 0.17 });
    expect(priorityWeights(["mission"])).toEqual({ mission: 1 });
    expect(priorityWeights([])).toEqual({});
  });

  test("checks things that don't fit together, and asks for missing reasons", () => {
    const p = prefs({
      salary: { min: 90000, target: 80000, ask: 70000, reasoning: "Current package" },
      workMode: ["hybrid"],
      priorities: ["pay", "Pay"],
      industries: { prefer: ["Fintech"], avoid: ["fintech"] },
      reasons: { vibes: "x" },
      dealBreakers: [{ rule: "No on-call", why: "Burnt out" }, "No agencies"],
    });
    expect(checkPreferences(p)).toEqual([
      "The salary minimum (90,000 GBP a year) is above the target (80,000 GBP a year).",
      "The opening ask (70,000 GBP a year) is below the target (80,000 GBP a year); the ask is usually at or above it.",
      "The opening ask (70,000 GBP a year) is below the minimum (90,000 GBP a year).",
      "Hybrid or office work, but no locations: where?",
      "A priority is listed twice.",
      expect.stringMatching(/^reasons\.vibes isn't a preference/),
      "industries: Fintech is both preferred and avoided.",
    ]);
    expect(unexplained(p)).toEqual(["workMode", "dealBreakers", "industries", "priorities"]);
  });

  test("setting a key changes only its line, and keeps the comment", () => {
    const text = "name: X\nlocations: []      # e.g. [London]\nsalary:\n  min: 1\n  target: 2\n# about angle\nangle:\n  theyBuy:\n";
    expect(setTopLevelKey(text, "locations", ["London", "Remote (UK)"])).toBe("name: X\nlocations: [London, Remote (UK)] # e.g. [London]\nsalary:\n  min: 1\n  target: 2\n# about angle\nangle:\n  theyBuy:\n");
    expect(setTopLevelKey(text, "salary", { min: 5 })).toBe("name: X\nlocations: []      # e.g. [London]\nsalary: {min: 5}\n# about angle\nangle:\n  theyBuy:\n");
    expect(setTopLevelKey(text, "locations", null)).toBe("name: X\nlocations:         # e.g. [London]\nsalary:\n  min: 1\n  target: 2\n# about angle\nangle:\n  theyBuy:\n");
    expect(setTopLevelKey(text, "hours", "4-day week", { before: "angle" })).toContain("target: 2\n# about angle\nhours: 4-day week\nangle:");
    expect(setTopLevelKey("a: 1\n", "b", "x: y")).toBe('a: 1\nb: "x: y"\n');
    expect(setTopLevelKey("why: []\n# fit: later\n", "titles", { core: ["A"] }, { block: true, afterComment: "# titles:", beforeComment: "# fit:" })).toBe("why: []\ntitles:\n  core:\n    - A\n# fit: later\n");
    // Long values as a block; replacing a block replaces all of it.
    const withFit = setTopLevelKey("name: X\n# fit: set later\nangle:\n", "fit", { level: "good", evidence: ["A", "B"] }, { block: true, afterComment: "# fit:" });
    expect(withFit).toBe("name: X\n# fit: set later\nfit:\n  level: good\n  evidence:\n    - A\n    - B\nangle:\n");
    expect(setTopLevelKey(withFit, "fit", { level: "leap" }, { block: true })).toBe("name: X\n# fit: set later\nfit:\n  level: leap\nangle:\n");
  });
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("saving preferences", () => {
  test("usual ones and a search's own, validated, logged, and merged", async () => {
    const root = await mkdtemp(join(tmpdir(), "ojs-prefs-"));
    roots.push(root);
    const env = { OJS_ROOT: root } as Record<string, string | undefined>;
    await addPerson("Sam", env);
    await expect(setPreferences("workMode: [remote]", {}, env)).rejects.toThrow(/--usual/);

    const u = await setPreferences("{locations: [London], dealBreakers: [No on-call]}", { usual: true }, env);
    expect(u).toMatchObject({ scope: "usual", file: "preferences.yaml", set: ["locations", "dealBreakers"], view: { search: null } });
    const personFolder = join(root, "data", "sam");
    expect((await readHistory(personFolder)).map((e) => e.action)).toEqual(["create", "prefs: locations, dealBreakers"]);

    await addSearch("Engineering", {}, env);
    const r = await setPreferences("{salary: {min: 70000, target: 80000}, priorities: [pay, growth], dealBreakers: [No agencies]}", {}, env);
    expect(r.view.preferences.locations).toEqual(["London"]);
    expect(r.view.hardRules.map((h) => h.rule)).toEqual(["No agencies", "No on-call", "Pay at least 70,000 GBP a year"]);
    expect(r.view.weights).toEqual({ pay: 0.67, growth: 0.33 });
    const yaml = await readFile(join(searchDir(env), "search.yaml"), "utf8");
    expect(yaml).toContain("salary: {min: 70000, target: 80000}");
    expect(yaml).toContain("# One job search");

    await expect(setPreferences("workMode: [sometimes]", {}, env)).rejects.toThrow(/nothing was saved/);
    await expect(setPreferences("vibes: good", {}, env)).rejects.toThrow(/not a preference: vibes/);
    await expect(setPreferences("- a list", {}, env)).rejects.toThrow(/mapping/);

    const cleared = await setPreferences("salary: null", {}, env);
    expect(cleared.cleared).toEqual(["salary"]);
    expect((await preferencesFor(personFolder, searchDir(env))).preferences.salary).toBeUndefined();

    // Saving a fit, twice, changes only the fit lines.
    const before = await readFile(join(searchDir(env), "search.yaml"), "utf8");
    await setFit({ level: "stretch", evidence: ["Checkout rebuild at Acme"], gaps: ["No budget yet"] }, env);
    await setFit({ level: "good", evidence: ["Checkout rebuild at Acme"] }, env);
    const after = await readFile(join(searchDir(env), "search.yaml"), "utf8");
    const changed = after.split("\n").filter((l) => !before.split("\n").includes(l));
    expect(changed[0]).toBe("fit:");
    expect(changed.every((l) => l === "fit:" || l.startsWith("  "))).toBe(true);
    expect(after.replace(/^fit:\n(  .*\n)+/m, "")).toBe(before);
    const last = (await readHistory(searchDir(env))).at(-1)!;
    const diff = last.hunks.flatMap((h) => h.lines).filter((l) => l.op !== " ");
    expect(diff.map((l) => `${l.op}${l.text}`)).toEqual(["-  level: stretch", "+  level: good", "-  gaps:", "-    - No budget yet", "+  gaps: []"]);
  });
});
