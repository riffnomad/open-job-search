import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffLines, formatEntry, parseHistory, readHistory, recordChange, reverseEntry, undoTarget, UndoError, type HistoryEntry } from "../src/profile/history.ts";
import { addBullets, applyUndo, correctProfile, createEntry, moveToPastLife, planUndo, ProfileError } from "../src/profile/store.ts";
import { findSection, parseProfileFile, sectionBullets } from "../src/profile/role-file.ts";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "ojs-history-")), "profile");
  await mkdir(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(join(d, ".."), { recursive: true, force: true })));
});

const entryFor = (before: string, after: string): HistoryEntry => ({ n: 1, when: "2026-11-21 10:00:00", action: "test", file: "roles/x.md", created: false, deleted: false, hunks: diffLines(before, after) });

describe("diffLines and reverseEntry", () => {
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const cases: [string, (s: string) => string][] = [
    ["append at end", (s) => s + "new last\n"],
    ["insert in the middle", (s) => s.replace("line 10\n", "line 10\ninserted\n")],
    ["change one line", (s) => s.replace("line 5\n", "line five\n")],
    ["remove a line", (s) => s.replace("line 20\n", "")],
    ["several changes far apart", (s) => s.replace("line 1\n", "one\n").replace("line 28\n", "twenty-eight\nextra\n")],
    ["several changes close together", (s) => s.replace("line 3\n", "x\n").replace("line 6\n", "y\n")],
    ["empty to something", () => "a\nb\n"],
    ["lines that look like markdown structure", (s) => s + "```\n## Not a heading of the log\n```\n"],
  ];
  for (const [name, edit] of cases) {
    test(name, () => {
      const before = name === "empty to something" ? "" : base;
      const after = edit(before);
      const entry = entryFor(before, after);
      expect(reverseEntry(entry, after)).toBe(before);
      // and the log text parses back to the same diff
      const parsed = parseHistory(formatEntry(entry))[0]!;
      expect(parsed.hunks).toEqual(entry.hunks);
      expect(reverseEntry(parsed, after)).toBe(before);
    });
  }

  test("only the changed lines and a little context are kept", () => {
    const hunks = diffLines(base, base.replace("line 15\n", "line 15\nadded\n"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines.map((l) => `${l.op}${l.text}`)).toEqual([" line 14", " line 15", "+added", " line 16", " line 17"]);
  });

  test("undo still works when lines above were added since", () => {
    const after = base.replace("line 20\n", "line 20\nlate addition\n");
    const entry = entryFor(base, after);
    const later = "added at the top\n" + after;
    expect(reverseEntry(entry, later)).toBe("added at the top\n" + base);
  });

  test("undo refuses when the lines it made have changed", () => {
    const after = base.replace("line 20\n", "line 20\nlate addition\n");
    const entry = entryFor(base, after);
    expect(() => reverseEntry(entry, after.replace("late addition", "edited by hand"))).toThrow(UndoError);
  });
});

describe("the log file", () => {
  test("is readable markdown, numbered, and only grows", async () => {
    const dir = await temp();
    expect(await recordChange(dir, "roles/a.md", null, "x\n", "create")).toBe(1);
    expect(await recordChange(dir, "roles/a.md", "x\n", "x\n", "dig")).toBeUndefined();
    expect(await recordChange(dir, "roles/a.md", "x\n", "x\ny\n", "dig")).toBe(2);
    const text = await readFile(join(dir, "history.md"), "utf8");
    expect(text).toStartWith("# Profile history\n");
    expect(text).toMatch(/\n## #1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · create · roles\/a\.md \(new file\)\n\n```diff\n@@ -1,1 \+1,2 @@\n\+x\n  ?\n```\n/);
    expect(text).toContain("· dig · roles/a.md\n\n```diff\n@@ -1,2 +1,3 @@\n x\n+y\n");
    expect((await readHistory(dir)).map((e) => e.n)).toEqual([1, 2]);
  });

  test("undo target skips undos and what they undid", () => {
    const e = (n: number, action: string) => ({ n, when: "", action, file: "f", created: false, deleted: false, hunks: [] });
    const list = [e(1, "dig"), e(2, "dig"), e(3, "undo #2")];
    expect(undoTarget(list).n).toBe(1);
    expect(() => undoTarget(list, 2)).toThrow(/already been undone/);
    expect(() => undoTarget(list, 3)).toThrow(/itself an undo/);
    expect(() => undoTarget([e(1, "undo #0")])).toThrow(/nothing to undo/);
  });
});

describe("undo and correct on a real profile", () => {
  async function withRole() {
    const dir = await temp();
    await createEntry("role", { employer: "Acme", positions: [{ title: "Engineer", start: "2019-01" }] }, dir);
    await addBullets("acme", { section: "Achievements", texts: ["Recovered $1M+ in fees."], source: { kind: "cv" } }, dir);
    await addBullets("acme", { section: "Stories", texts: ["A story."], source: { kind: "dig", date: "2026-11-21" } }, dir);
    return dir;
  }
  const file = "roles/2019-01-acme.md";

  test("undo the latest, then the one before, then the file itself", async () => {
    const dir = await withRole();
    const read = () => readFile(join(dir, file), "utf8");
    let plan = await planUndo(dir);
    expect(plan.entry.n).toBe(3);
    expect(await applyUndo(plan, dir)).toBe(4);
    expect(await read()).not.toContain("A story.");
    expect(await read()).toContain("Recovered $1M+ in fees.");

    plan = await planUndo(dir);
    expect(plan.entry.n).toBe(2);
    await applyUndo(plan, dir);
    expect(await read()).not.toContain("Recovered");

    plan = await planUndo(dir);
    expect(plan).toMatchObject({ entry: { n: 1, action: "create" }, text: null });
    await applyUndo(plan, dir);
    await expect(access(join(dir, file))).rejects.toThrow();
    await expect(planUndo(dir)).rejects.toThrow(/nothing to undo/);
  });

  test("correct replaces exactly one match, logs it, and can be undone", async () => {
    const dir = await withRole();
    const res = await correctProfile("acme", { find: "Recovered $1M+ in fees. [cv]", replace: "Found $1M lost to a bug, and fixed it. [dig 2026-11-21]" }, dir);
    expect(res).toEqual({ file, before: ["- Recovered $1M+ in fees. [cv]"], after: ["- Found $1M lost to a bug, and fixed it. [dig 2026-11-21]"], written: true });
    expect((await readHistory(dir)).at(-1)).toMatchObject({ n: 4, action: "correct" });
    await applyUndo(await planUndo(dir), dir);
    expect(await readFile(join(dir, file), "utf8")).toContain("- Recovered $1M+ in fees. [cv]");
  });

  test("correct --remove deletes the whole line", async () => {
    const dir = await withRole();
    const res = await correctProfile("acme", { find: "A story.", remove: true }, dir);
    expect(res.after).toEqual([]);
    expect(await readFile(join(dir, file), "utf8")).not.toContain("A story.");
  });

  test("correct refuses missing, ambiguous, or file-breaking changes, and writes nothing", async () => {
    const dir = await withRole();
    const before = await readFile(join(dir, file), "utf8");
    await expect(correctProfile("acme", { find: "nope", replace: "x" }, dir)).rejects.toThrow(/isn't in/);
    await expect(correctProfile("acme", { find: "- ", replace: "x" }, dir)).rejects.toThrow(/appears \d+ times/);
    await expect(correctProfile("acme", { find: "employer: Acme", replace: "employer:" }, dir)).rejects.toThrow(ProfileError);
    await expect(correctProfile("acme", { find: "A story." }, dir)).rejects.toThrow(/--replace/);
    expect(await readFile(join(dir, file), "utf8")).toBe(before);
    expect((await readHistory(dir)).length).toBe(3);
  });

  test("correct works on profile.yaml", async () => {
    const dir = await temp();
    await writeFile(join(dir, "profile.yaml"), "version: 1\nbasics:\n  name: Sam\n");
    await correctProfile("profile", { find: "name: Sam", replace: "name: Sam Example" }, dir);
    expect(await readFile(join(dir, "profile.yaml"), "utf8")).toContain("name: Sam Example");
    expect((await readHistory(dir))[0]).toMatchObject({ action: "correct", file: "profile.yaml" });
  });
});

describe("moveToPastLife", () => {
  async function withBarJob() {
    const dir = await temp();
    await createEntry("role", { employer: "The Crown", positions: [{ title: "Bartender", start: "2012-06", end: "2014" }], industry: "Hospitality", skills: ["Cocktails"] }, dir);
    await addBullets("crown", { section: "What I owned", texts: ["Ran the bar on Saturdays."], source: { kind: "cv" } }, dir);
    await addBullets("crown", { section: "Projects", subheading: "New menu", texts: ["Wrote the cocktail menu."], source: { kind: "dig", date: "2026-11-21" } }, dir);
    await addBullets("crown", { section: "Achievements", texts: ["Takings up 20%."], source: { kind: "you" } }, dir);
    await addBullets("crown", { section: "Hard moments", texts: ["A fight on New Year's Eve."], source: { kind: "dig", date: "2026-11-21" } }, dir);
    await addBullets("crown", { section: "Still to ask", texts: ["How many covers on a busy night?"], source: { kind: "dig", date: "2026-11-21" } }, dir);
    return dir;
  }

  test("keeps every line and source, maps sections, removes the role, logs both", async () => {
    const dir = await withBarJob();
    const preview = await moveToPastLife("crown", { dryRun: true }, dir);
    expect(preview).toMatchObject({ from: "roles/2012-06-the-crown.md", to: "past-lives/hospitality.md", merged: false, lines: 6, written: false });
    await access(join(dir, "roles/2012-06-the-crown.md"));

    const res = await moveToPastLife("crown", {}, dir);
    expect(res.written).toBe(true);
    expect(res.sections).toEqual([
      { from: "What I owned", to: "What I did" },
      { from: "Projects", to: "Projects" },
      { from: "Achievements", to: "What I did" },
      { from: "Hard moments", to: "Stories" },
      { from: "Still to ask", to: "Still to ask" },
    ]);
    await expect(access(join(dir, "roles/2012-06-the-crown.md"))).rejects.toThrow();
    const life = parseProfileFile("past-life", await readFile(join(dir, "past-lives/hospitality.md"), "utf8"));
    expect(life.frontMatter).toMatchObject({ field: "Hospitality", roles: [{ title: "Bartender", employer: "The Crown", period: "2012-06 to 2014" }], skills: ["Cocktails"] });
    const bullets = (h: string) => sectionBullets(findSection(life, h)!).map((b) => [b.text, b.source.kind, b.subheading]);
    expect(bullets("What I did")).toEqual([["Ran the bar on Saturdays.", "cv", undefined], ["Takings up 20%.", "you", undefined]]);
    expect(bullets("Projects")).toEqual([["Wrote the cocktail menu.", "dig", "New menu"]]);
    expect(bullets("Stories")).toEqual([["A fight on New Year's Eve.", "dig", undefined]]);
    expect(bullets("Still to ask")).toEqual([["How many covers on a busy night?", "dig", undefined]]);
    expect((await readHistory(dir)).slice(-2).map((e) => [e.action, e.file, e.created, e.deleted])).toEqual([
      ["move from roles/2012-06-the-crown.md", "past-lives/hospitality.md", true, false],
      ["move to past-lives/hospitality.md", "roles/2012-06-the-crown.md", false, true],
    ]);
  });

  test("two undos put it all back", async () => {
    const dir = await withBarJob();
    const before = await readFile(join(dir, "roles/2012-06-the-crown.md"), "utf8");
    await moveToPastLife("crown", {}, dir);
    await applyUndo(await planUndo(dir), dir);
    expect(await readFile(join(dir, "roles/2012-06-the-crown.md"), "utf8")).toBe(before);
    await applyUndo(await planUndo(dir), dir);
    await expect(access(join(dir, "past-lives/hospitality.md"))).rejects.toThrow();
  });

  test("adds to a past life with the same field, and needs a field when there's no industry", async () => {
    const dir = await withBarJob();
    await createEntry("past-life", { field: "Hospitality", roles: [{ title: "Waiter" }] }, dir);
    await addBullets("hospitality", { section: "What I did", subheading: "Weddings", texts: ["Served weddings of 200."], source: { kind: "dig", date: "2026-11-20" } }, dir);
    const res = await moveToPastLife("crown", {}, dir);
    expect(res.merged).toBe(true);
    const life = parseProfileFile("past-life", await readFile(join(dir, "past-lives/hospitality.md"), "utf8"));
    expect(life.frontMatter.roles.map((r) => r.title)).toEqual(["Waiter", "Bartender"]);
    // plain lines go before the existing ### block, not inside it
    expect(sectionBullets(findSection(life, "What I did")!).map((b) => [b.text, b.subheading])).toEqual([
      ["Ran the bar on Saturdays.", undefined],
      ["Takings up 20%.", undefined],
      ["Served weddings of 200.", "Weddings"],
    ]);

    await createEntry("role", { employer: "Odd Jobs", positions: [{ title: "Helper", start: "2010" }] }, dir);
    await expect(moveToPastLife("odd", {}, dir)).rejects.toThrow(/--field/);
    await expect(moveToPastLife("hospitality", { field: "X" }, dir)).rejects.toThrow(ProfileError);
  });
});
