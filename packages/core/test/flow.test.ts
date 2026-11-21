import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowError, flowStatus, markStepDone, reopenStep } from "../src/flow.ts";
import { addBullets, createEntry } from "../src/profile/store.ts";

const roots: string[] = [];
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ojs-flow-"));
  roots.push(root);
  await mkdir(join(root, "documents", "sam"), { recursive: true });
  return { person: join(root, "data", "sam"), profile: join(root, "data", "sam", "profile"), documents: join(root, "documents", "sam") };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("flow", () => {
  test("starts at step 1, which needs at least one role", async () => {
    const ws = await workspace();
    const s = await flowStatus(ws);
    expect(s.current).toBe("experience");
    expect(s.steps.map((x) => [x.id, x.state])).toEqual([["experience", "current"], ["past-lives", "locked"], ["targets", "locked"], ["preferences", "locked"]]);
    expect(s.steps[0]!.blockers).toEqual(["No roles yet: import a CV or add a role first."]);
    await expect(markStepDone("experience", ws)).rejects.toThrow(/No roles yet/);
    await expect(markStepDone("past-lives", ws)).rejects.toThrow(/Step 1 comes first/);
  });

  test("suggests, never requires: undug roles, documents to import, open questions", async () => {
    const ws = await workspace();
    await createEntry("role", { employer: "Acme", positions: [{ title: "Engineer", start: "2020" }] }, ws.profile);
    await createEntry("role", { employer: "Globex", positions: [{ title: "Intern", start: "2018" }] }, ws.profile);
    await addBullets("acme", { section: "Stories", texts: ["A story."], source: { kind: "dig", date: "2026-11-21" } }, ws.profile);
    await addBullets("globex", { section: "Still to ask", texts: ["What did you build?"], source: { kind: "dig", date: "2026-11-21" } }, ws.profile);
    await writeFile(join(ws.documents, "old-cv.txt"), "An old CV");
    const step = (await flowStatus(ws)).steps[0]!;
    expect(step.progress).toEqual(["2 roles, 1 line of experience", "2 of 2 roles dug into"]);
    expect(step.suggestions).toEqual(["Import old-cv.txt (new or changed in documents/)", '1 question saved under "Still to ask"']);
    expect(step.blockers).toEqual([]);
  });

  test("steps go in order, are remembered, and can be reopened", async () => {
    const ws = await workspace();
    await createEntry("role", { employer: "Acme", positions: [{ title: "Engineer", start: "2020" }] }, ws.profile);
    const after1 = await markStepDone("1", { ...ws, now: new Date("2026-11-21T10:00:00Z") });
    expect(after1.current).toBe("past-lives");
    expect(after1.steps[0]).toMatchObject({ state: "done", doneAt: "2026-11-21T10:00:00.000Z" });
    expect(JSON.parse(await readFile(join(ws.person, "flow.json"), "utf8"))).toEqual({ version: 1, done: { experience: "2026-11-21T10:00:00.000Z" } });
    expect((await stat(join(ws.person, "flow.json"))).mode & 0o777).toBe(0o600);
    await expect(markStepDone("experience", ws)).rejects.toThrow(/already done/);

    // No past lives is fine: the person decides.
    const after2 = await markStepDone("past-lives", ws);
    expect(after2.current).toBe("targets");

    // Step 3 needs a search; fit is suggested, and flagged again once the profile moves on.
    const targets = after2.steps[2]!;
    expect(targets.progress).toEqual(["No searches yet"]);
    expect(targets.blockers).toEqual(["No searches yet: decide what to look for first."]);
    await mkdir(join(ws.person, "searches", "eng"), { recursive: true });
    await writeFile(join(ws.person, "searches", "eng", "search.yaml"), "name: Engineering\ntargetRoles: [Engineer]\nwhy: [Loves it]\ntitles: { core: [Engineer], open: [{ title: Member of Technical Staff, if: pay at or above target }] }\nfit: { level: good, assessedAt: 2026-11-21, profileChange: 1 }\n");
    await mkdir(join(ws.person, "searches", "mgmt"), { recursive: true });
    await writeFile(join(ws.person, "searches", "mgmt", "search.yaml"), "name: Management\n");
    const s3 = (await flowStatus(ws)).steps[2]!;
    expect(s3.progress).toEqual(["2 searches: Engineering, Management"]);
    expect(s3.suggestions).toEqual(['Add target roles to "Management"', 'Ask why they want "Management"', 'Build the titles to search for "Management": exact ones, similar ones the profile backs, flat titles worth a look, words that rule a title out', 'Assess how well the profile backs "Management"']);
    await addBullets("acme", { section: "Stories", texts: ["Another story."], source: { kind: "dig", date: "2026-11-21" } }, ws.profile);
    expect((await flowStatus(ws)).steps[2]!.suggestions).toEqual([
      '"Engineering": the profile has 1 change since its fit was assessed; check it again',
      'Add target roles to "Management"',
      'Ask why they want "Management"',
      'Build the titles to search for "Management": exact ones, similar ones the profile backs, flat titles worth a look, words that rule a title out',
      'Assess how well the profile backs "Management"',
    ]);
    const after3 = await markStepDone("targets", ws);
    expect(after3.current).toBe("preferences");

    // Step 4 is per search: it needs one chosen, and remembers which searches are done.
    expect(after3.steps[3]!.blockers).toEqual(["Choose which search to work on: `ojs search use <name>`."]);
    const eng = { ...ws, search: join(ws.person, "searches", "eng") };
    const s4 = (await flowStatus(eng)).steps[3]!;
    expect(s4.progress).toEqual(["Nothing set yet", "Other searches still to do: Management"]);
    expect(s4.blockers).toEqual(["Nothing saved for this search yet: `ojs prefs set`."]);
    await writeFile(join(ws.person, "preferences.yaml"), "version: 1\nlocations: [London]\nworkMode: [hybrid]\nreasons: { workMode: Likes the team days }\n");
    await writeFile(
      join(eng.search, "search.yaml"),
      "name: Engineering\ntargetRoles: [Engineer]\nsalary: { min: 90000, target: 80000 }\npriorities: [pay, growth]\n",
    );
    const s4b = (await flowStatus(eng)).steps[3]!;
    expect(s4b.progress).toEqual(["4 preferences set (2 from their usual ones)", "Priorities: pay, growth", "1 hard rule: Pay at least 90,000 GBP a year", "Other searches still to do: Management"]);
    expect(s4b.suggestions).toEqual([
      "This search has no titles to search for yet (step 3's list): build them with `ojs search titles` (see the targets skill)",
      "Ask if anything would rule a job out",
      "Ask why: locations, salary, priorities",
      "Check: The salary minimum (90,000 GBP a year) is above the target (80,000 GBP a year).",
    ]);
    const after4 = await markStepDone("preferences", eng);
    expect(after4.complete).toBe(true);
    expect(JSON.parse(await readFile(join(eng.search, "flow.json"), "utf8")).done.preferences).toBeString();
    // Another search starts step 4 afresh, without repeating steps 1 to 3.
    const mgmt = await flowStatus({ ...ws, search: join(ws.person, "searches", "mgmt") });
    expect(mgmt.current).toBe("preferences");
    expect(mgmt.steps[3]!.progress).toContain("2 preferences set (2 from their usual ones)");

    expect(await reopenStep("experience", eng)).toEqual(["experience", "past-lives", "targets", "preferences"]);
    expect((await flowStatus(ws)).current).toBe("experience");
    await expect(markStepDone("nope", ws)).rejects.toThrow(FlowError);
  });
});
