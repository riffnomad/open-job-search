// Switching on a job board that's off by default: the --json output is a contract.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "ojs-jobs-cli-"));
afterAll(() => rm(home, { recursive: true, force: true }));
const entry = join(import.meta.dir, "../src/index.ts");

function ojs(...args: string[]): { code: number; json: any } {
  const p = Bun.spawnSync(["bun", entry, ...args, "--json"], { env: { ...process.env, OJS_ROOT: home } });
  const stdout = p.stdout.toString().trim();
  const { workingOn: _, ...json } = stdout ? JSON.parse(stdout) : {};
  return { code: p.exitCode, json: stdout ? json : undefined };
}

describe("ojs jobs on / off", () => {
  test("LinkedIn starts off, and searching it says how to switch it on, without a request", () => {
    const board = ojs("jobs", "sources").json.jobBoards.find((b: { id: string }) => b.id === "linkedin");
    expect(board).toMatchObject({ optIn: true, on: false });
    const r = ojs("jobs", "search", "linkedin", "engineer");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatch(/off until you switch it on.*terms.*ojs jobs on linkedin --yes/s);
  });

  test("on without --yes explains and changes nothing; with --yes it's saved; off undoes it", async () => {
    const asked = ojs("jobs", "on", "linkedin").json;
    expect(asked).toMatchObject({ board: "linkedin", on: false, confirmWith: "ojs jobs on linkedin --yes" });
    expect(asked.why).toMatch(/terms/);
    expect(ojs("jobs", "sources").json.jobBoards.find((b: { id: string }) => b.id === "linkedin").on).toBe(false);

    expect(ojs("jobs", "on", "linkedin", "--yes").json).toEqual({ board: "linkedin", on: true });
    expect(JSON.parse(await readFile(join(home, "data", "config.json"), "utf8")).jobBoardsOn).toEqual(["linkedin"]);
    expect(ojs("jobs", "sources").json.jobBoards.find((b: { id: string }) => b.id === "linkedin").on).toBe(true);
    expect(ojs("jobs", "on", "linkedin", "--yes").json).toEqual({ board: "linkedin", on: true });
    expect(JSON.parse(await readFile(join(home, "data", "config.json"), "utf8")).jobBoardsOn).toEqual(["linkedin"]);

    expect(ojs("jobs", "off", "linkedin").json).toEqual({ board: "linkedin", on: false });
    expect(ojs("jobs", "sources").json.jobBoards.find((b: { id: string }) => b.id === "linkedin").on).toBe(false);
  });

  test("boards that are always on have nothing to switch", () => {
    const r = ojs("jobs", "on", "reed", "--yes");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatch(/always on/);
    expect(ojs("jobs", "sources").json.jobBoards.find((b: { id: string }) => b.id === "reed").optIn).toBeUndefined();
  });
});
