import { describe, expect, test } from "bun:test";
import { HANDED_SOURCES, handedSource, parseHandedJobs, SourceError } from "../src/index.ts";

// Made-up companies, as an agent would hand them over after searching with a connector.
describe("jobs handed over by the agent", () => {
  test("Indeed is the one source so far, with how to reach it and a credit", () => {
    expect(Object.keys(HANDED_SOURCES)).toEqual(["indeed"]);
    expect(handedSource("Indeed").via).toMatch(/connector/);
    expect(handedSource("indeed").credit).toMatch(/Indeed/);
    expect(() => handedSource("monster")).toThrow(SourceError);
  });

  test("a job in YAML: its place, pay read when plain, date, notes", () => {
    const { jobs, skipped } = parseHandedJobs(
      `- id: abc123
  title: Senior Backend Engineer
  company: Acme
  location: London
  url: https://uk.indeed.com/viewjob?jk=abc123
  pay: "£80,000 - £95,000 a year"
  postedAt: "2026-11-25"
  signals: [Full-time, " Hybrid "]
  description: Build things.`,
      "indeed",
    );
    expect(skipped).toEqual([]);
    expect(jobs).toEqual([
      {
        id: expect.stringMatching(/^indeed:jobs:[0-9a-z]+$/),
        source: "indeed",
        board: "jobs",
        company: "Acme",
        title: "Senior Backend Engineer",
        locations: ["London"],
        url: "https://uk.indeed.com/viewjob?jk=abc123",
        postedAt: "2026-11-25",
        pay: [{ min: 80000, max: 95000, currency: "GBP", period: "year" }],
        description: "Build things.",
        signals: ["Full-time", "Hybrid"],
      },
    ]);
  });

  test("JSON, or {jobs: […]}, works too; pay it can't read is kept as written; split pay taken as given", () => {
    const json = JSON.stringify({
      jobs: [
        { title: "Platform Engineer", company: "Globex", url: "https://uk.indeed.com/viewjob?jk=def", pay: "Up to £90k", locations: ["Remote, UK"] },
        { id: 7, title: "SRE", company: "Initech", url: "https://uk.indeed.com/viewjob?jk=ghi", pay: { min: 70000, max: 80000, currency: "gbp", period: "year" } },
      ],
    });
    const { jobs } = parseHandedJobs(json, "indeed");
    expect(jobs[0]!.pay).toEqual([]);
    expect(jobs[0]!.description).toBe("Pay, as the source gives it: Up to £90k");
    expect(jobs[0]!.remote).toBe(true);
    expect(jobs[1]!.pay).toEqual([{ min: 70000, max: 80000, currency: "GBP", period: "year" }]);
  });

  test("entries without a title, company or web link are left out with the reason; repeats once; odd dates dropped", () => {
    const { jobs, skipped } = parseHandedJobs(
      `[
        {title: A, company: Acme, url: "https://x.example/1", postedAt: "last week"},
        {title: B, company: Acme},
        {title: "", company: Acme, url: "https://x.example/2"},
        {title: C, company: Acme, url: "javascript:alert(1)"},
        {title: A, company: Acme, url: "https://x.example/1"}
      ]`,
      "indeed",
    );
    expect(jobs.map((j) => j.title)).toEqual(["A"]);
    expect(jobs[0]!.postedAt).toBeUndefined();
    expect(skipped.map((s) => s.entry)).toEqual([2, 3, 4, 5]);
    expect(skipped[0]!.why).toMatch(/^url:/);
    expect(skipped[3]!.why).toBe("the same job again");
  });

  test("Indeed's ids are places in one search and its links change, so a job's id comes from what it is", () => {
    // As the connector returns them: the same job is result 4 in one search and 1 in the next, with a new short link.
    const first = parseHandedJobs(
      `[{id: JOBSEARCH_4, title: Staff Engineer, company: Acme, location: London, url: "https://to.indeed.com/aa1"},
        {id: JOBSEARCH_1, title: Data Engineer, company: Globex, location: London, url: "https://to.indeed.com/aa2"}]`,
      "indeed",
    ).jobs;
    const second = parseHandedJobs(`[{id: JOBSEARCH_1, title: " Staff  Engineer", company: acme, location: London, url: "https://to.indeed.com/aa9"}]`, "indeed").jobs;
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(first[1]!.id).not.toBe(second[0]!.id);
    // Same title and company in another place is another job.
    const elsewhere = parseHandedJobs(`[{title: Staff Engineer, company: Acme, location: Leeds, url: "https://to.indeed.com/aa1"}]`, "indeed").jobs;
    expect(elsewhere[0]!.id).not.toBe(first[0]!.id);
  });

  test("dates written out (\"August 18, 2026\") become that day, as YYYY-MM-DD", () => {
    const { jobs } = parseHandedJobs(`[{title: A, company: Acme, url: "https://x.example/1", postedAt: "August 18, 2026"}, {title: B, company: Acme, url: "https://x.example/2", postedAt: "June 08, 2026"}]`, "indeed");
    expect(jobs.map((j) => j.postedAt)).toEqual(["2026-08-18", "2026-06-08"]);
  });

  test("not a list, or not YAML at all, says so", () => {
    expect(() => parseHandedJobs("title: A", "indeed")).toThrow(/give a list of jobs/);
    expect(() => parseHandedJobs("[unclosed", "indeed")).toThrow(/isn't valid YAML or JSON/);
  });
});
