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
    expect(s.steps.map((x) => [x.id, x.state])).toEqual([["experience", "current"], ["past-lives", "locked"], ["targets", "locked"]]);
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
    await writeFile(join(ws.person, "searches", "eng", "search.yaml"), "name: Engineering\ntargetRoles: [Engineer]\nwhy: [Loves it]\nfit: { level: good, assessedAt: 2026-11-21, profileChange: 1 }\n");
    await mkdir(join(ws.person, "searches", "mgmt"), { recursive: true });
    await writeFile(join(ws.person, "searches", "mgmt", "search.yaml"), "name: Management\n");
    const s3 = (await flowStatus(ws)).steps[2]!;
    expect(s3.progress).toEqual(["2 searches: Engineering, Management"]);
    expect(s3.suggestions).toEqual(['Add target roles to "Management"', 'Ask why they want "Management"', 'Assess how well the profile backs "Management"']);
    await addBullets("acme", { section: "Stories", texts: ["Another story."], source: { kind: "dig", date: "2026-11-21" } }, ws.profile);
    expect((await flowStatus(ws)).steps[2]!.suggestions).toEqual([
      '"Engineering": the profile has 1 change since its fit was assessed; check it again',
      'Add target roles to "Management"',
      'Ask why they want "Management"',
      'Assess how well the profile backs "Management"',
    ]);
    const after3 = await markStepDone("targets", ws);
    expect(after3.complete).toBe(true);
    expect(after3.current).toBeUndefined();

    expect(await reopenStep("experience", ws)).toEqual(["experience", "past-lives", "targets"]);
    expect((await flowStatus(ws)).current).toBe("experience");
    await expect(markStepDone("nope", ws)).rejects.toThrow(FlowError);
  });
});
