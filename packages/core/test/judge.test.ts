import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JUDGMENTS_FILE, judgeTitles, knownCalls, type LLMProvider, parseSavedCalls, saveCalls, Titles, titlesHash } from "../src/index.ts";

const titles = Titles.parse({
  core: ["Staff Engineer"],
  related: [{ title: "Engineering Manager", why: "Led a team at Acme" }],
  open: [{ title: "Member of Technical Staff", if: "pay at or above target" }],
  exclude: ["Intern"],
});

/** A made-up AI: answers from a table, counts what it was asked. */
function fakeAi(answers: Record<string, { verdict: string; level?: string; title?: string; why: string }>) {
  const asked: string[][] = [];
  const provider: LLMProvider = {
    id: "fake",
    kind: "api",
    async generateText({ prompt }) {
      const batch = [...prompt.matchAll(/^(\d+)\. (".*")$/gm)].map((m) => JSON.parse(m[2]!) as string);
      asked.push(batch);
      return JSON.stringify({ results: batch.flatMap((t, i) => (answers[t] ? [{ n: i + 1, ...answers[t] }] : [])) });
    },
  };
  return { provider, asked };
}

const ANSWERS = {
  "Staff Software Engineer, Payments": { verdict: "core", level: "same", title: "Staff Engineer", why: "Same level; Payments is the team" },
  "Senior Staff Engineer": { verdict: "core", level: "above", title: "Staff Engineer", why: "Senior Staff is a level up" },
  "Software Engineer III": { verdict: "core", title: "Staff Engineer", why: "Numbered levels differ by company" },
  "Staff Nurse": { verdict: "different", why: "A nursing job" },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "ojs-judge-"));
  dirs.push(d);
  return d;
};

describe("judging titles", () => {
  test("rules first, then the AI once per new title; answers are remembered", async () => {
    const dir = await tmp();
    const ads = ["Staff Engineer", "Summer Intern", ...Object.keys(ANSWERS), "staff  software engineer, payments"];
    const { provider, asked } = fakeAi(ANSWERS);

    const before = await knownCalls(ads, titles, dir);
    expect(before.counts).toEqual({ rule: 2, stored: 0, judged: 0 });
    expect(before.unjudged).toEqual(Object.keys(ANSWERS)); // the twin differing in case and spacing isn't asked twice

    const j = await judgeTitles(ads, titles, dir, provider, { batchSize: 3 });
    expect(asked.flat()).toEqual(Object.keys(ANSWERS));
    expect(asked).toHaveLength(2);
    expect(j.calls.get("Staff Engineer")).toEqual({ verdict: "core", level: "same", title: "Staff Engineer", by: "rule" });
    expect(j.calls.get("Summer Intern")).toEqual({ verdict: "excluded", word: "Intern", by: "rule" });
    expect(j.calls.get("Senior Staff Engineer")).toEqual({ verdict: "core", level: "above", title: "Staff Engineer", why: "Senior Staff is a level up", by: "ai" });
    // No level given: it isn't shown by the title.
    expect(j.calls.get("Software Engineer III")?.level).toBe("unclear");
    expect(j.calls.get("Staff Nurse")).toEqual({ verdict: "different", why: "A nursing job", by: "ai" });
    expect(j.calls.get("staff  software engineer, payments")?.verdict).toBe("core");
    expect(j.unjudged).toEqual([]);

    // Next time: nothing goes to the AI.
    const again = await judgeTitles(ads, titles, dir, provider);
    expect(asked).toHaveLength(2);
    expect(again.counts).toEqual({ rule: 2, stored: 5, judged: 0 });
    const file = JSON.parse(await readFile(join(dir, JUDGMENTS_FILE), "utf8"));
    expect(file.entries["senior staff engineer"]).toMatchObject({ verdict: "core", level: "above", by: "ai", titles: titlesHash(titles) });
  });

  test("titles the AI skipped stay unjudged; changing the lists re-judges, the person's verdicts stick", async () => {
    const dir = await tmp();
    const { provider, asked } = fakeAi({ "Senior Staff Engineer": ANSWERS["Senior Staff Engineer"] });
    const j = await judgeTitles(["Senior Staff Engineer", "Head of Platform"], titles, dir, provider);
    expect(j.unjudged).toEqual(["Head of Platform"]);

    await saveCalls(parseSavedCalls("[{title: Head of Platform, verdict: related, of: Engineering Manager, why: same job at a startup}]"), titles, dir, "person");
    const changed = Titles.parse({ ...titles, core: ["Staff Engineer", "Principal Engineer"] });
    const k = await knownCalls(["Senior Staff Engineer", "Head of Platform"], changed, dir);
    expect(k.unjudged).toEqual(["Senior Staff Engineer"]);
    expect(k.calls.get("Head of Platform")).toEqual({ verdict: "related", level: "unclear", title: "Engineering Manager", why: "same job at a startup", by: "person" });
    expect(asked).toHaveLength(1);
  });

  test("saved verdicts are checked", () => {
    expect(() => parseSavedCalls("[{title: X, verdict: maybe}]")).toThrow(/nothing was saved/);
    expect(() => parseSavedCalls("[unclosed")).toThrow(/isn't valid YAML/);
    expect(() => parseSavedCalls("[{title: X, verdict: core, level: huge}]")).toThrow(/nothing was saved/);
    expect(parseSavedCalls("{title: Head of Platform, verdict: core, level: above}")).toEqual([{ title: "Head of Platform", verdict: "core", level: "above" }]);
  });

  test("verdicts saved before level was split out are asked again, even the person's", async () => {
    const dir = await tmp();
    const old = { version: 1, entries: { "senior staff engineer": { verdict: "above", title: "Staff Engineer", by: "person", at: "2026-11-01T00:00:00Z" } } };
    await writeFile(join(dir, JUDGMENTS_FILE), JSON.stringify(old));
    expect((await knownCalls(["Senior Staff Engineer"], titles, dir)).unjudged).toEqual(["Senior Staff Engineer"]);
  });
});
