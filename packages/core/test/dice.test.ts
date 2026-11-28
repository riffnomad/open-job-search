import { describe, expect, test } from "bun:test";
import { connectMcp, dice, SEARCH_SOURCES, searchSource, SourceError, USER_AGENT } from "../src/index.ts";

// Made-up companies, in the shape Dice's MCP server (search_jobs) sent in November 2026.
const ad = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `internal${n}`,
  guid: `0000000${n}-aaaa-bbbb-cccc-000000000000`,
  title: `Job ${n}`,
  summary: `About job ${n}...`,
  postedDate: "2026-11-26T20:10:23Z",
  modifiedDate: "2026-11-28T12:13:48Z",
  jobLocation: { displayName: "Austin, Texas, USA" },
  detailsPageUrl: `https://www.dice.com/job-detail/0000000${n}-aaaa-bbbb-cccc-000000000000?utm_source=open-job-search (+https:--github.com-riffnomad-open-job-search)&utm_medium=mcp`,
  salary: "USD 120,000.00 - 150,000.00 per year",
  clientBrandId: "123",
  companyPageUrl: "https://www.dice.com/company/123",
  companyLogoUrl: "https://example.com/acme.png",
  companyName: "Acme",
  employmentType: "Full-time",
  isHighlighted: null,
  score: 100,
  easyApply: false,
  employerType: "Direct Hire",
  workFromHomeAvailability: "FALSE",
  workplaceTypes: ["On-Site"],
  isRemote: false,
  willingToSponsor: false,
  ...extra,
});

const page = (data: unknown[], total = data.length, country = "US") => ({
  data,
  metadata: { page: 1, pageSize: data.length, total, searchedLocation: { countryCode2: country, radius: 30, radiusUnit: "mi" } },
});

interface Call {
  body: { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  headers: Record<string, string>;
}

type Answer = { result?: unknown; error?: { code: number; message: string } } | { status: number };

/**
 * An MCP server over Streamable HTTP. Each tools/call gets the next answer;
 * `sse` sends replies as server-sent events, as Dice does, with a note first.
 */
function fakeServer(answers: Answer[], o: { sse?: boolean; session?: string } = {}) {
  const calls: Call[] = [];
  let next = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Call["body"];
    calls.push({ body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.href !== "https://mcp.dice.com/mcp") return new Response("", { status: 404 });
    if (body.id === undefined) return new Response("", { status: 202 });
    let answer: Answer = { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Job Search MCP Server", version: "1.0.0" } } };
    if (body.method === "tools/call") answer = answers[next++] ?? { status: 500 };
    if ("status" in answer) return new Response("", { status: answer.status });
    const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, ...answer });
    const headers: Record<string, string> = { "content-type": o.sse ? "text/event-stream" : "application/json", ...(o.session ? { "mcp-session-id": o.session } : {}) };
    const text = o.sse ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${msg}\n\n` : msg;
    return new Response(text, { status: 200, headers });
  }) as typeof fetch;
  return { f, calls, tools: () => calls.filter((c) => c.body.method === "tools/call") };
}

const tool = (body: unknown, structured = false) => ({
  result: structured ? { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body } : { content: [{ type: "text", text: JSON.stringify(body) }] },
});
const opts = (f: typeof fetch) => ({ fetch: f, pauseMs: 0 });

describe("mcp client", () => {
  test("starts a session, then calls the tool; reads JSON or events, keeps the session id", async () => {
    for (const sse of [false, true]) {
      const s = fakeServer([tool({ ok: 1 }), tool({ ok: 2 }, true)], { sse, session: "s-1" });
      const mcp = await connectMcp("https://mcp.dice.com/mcp", "Dice", opts(s.f));
      expect(await mcp.callTool("search_jobs", { keyword: "x" })).toEqual({ ok: 1 });
      expect(await mcp.callTool("search_jobs", { keyword: "y" })).toEqual({ ok: 2 });
      expect(s.calls.map((c) => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
      expect(s.calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
      expect(s.calls[0]!.headers.accept).toBe("application/json, text/event-stream");
      expect(s.calls[0]!.headers["mcp-session-id"]).toBeUndefined();
      expect(s.calls[2]!.headers["mcp-session-id"]).toBe("s-1");
      expect(s.calls[2]!.body.params).toEqual({ name: "search_jobs", arguments: { keyword: "x" } });
    }
  });

  test("a tool error, a protocol error, a refusal and an odd reply, in plain words", async () => {
    const err = async (a: Answer) => {
      const mcp = await connectMcp("https://mcp.dice.com/mcp", "Dice", opts(fakeServer([a]).f));
      return mcp.callTool("search_jobs", {}).then(() => new Error("no error"), (e: Error) => e);
    };
    const e1 = await err({ result: { content: [{ type: "text", text: "Error calling tool: jobsPerPage\n  Input should be less than or equal to 100" }], isError: true } });
    expect(e1).toBeInstanceOf(SourceError);
    expect(e1.message).toBe("Dice couldn't do that: Error calling tool: jobsPerPage");
    expect((await err({ error: { code: -32602, message: "Unknown tool" } })).message).toBe("Dice said no: Unknown tool");
    expect((await err({ status: 429 })).message).toMatch(/asking too often/);
    expect((await err({ status: 403 })).message).toMatch(/turned us away \(403\)/);
    expect((await err({ result: { content: [{ type: "text", text: "not json" }] } })).message).toMatch(/valid JSON/);
  });
});

describe("dice", () => {
  test("is registered as a US job board, no key, with a credit that says AI found the jobs", () => {
    expect(SEARCH_SOURCES.dice).toBe(dice);
    expect(searchSource("Dice")).toBe(dice);
    expect(dice.places).toBe(true);
    expect(dice.countries).toEqual(["us"]);
    expect(dice.keys).toBeUndefined();
    expect(dice.optIn).toBeUndefined();
    expect(dice.credit).toMatch(/Dice.*AI-assisted.*check the details with the employer/);
  });

  test("a job: clean link, pay, dates, company page and logo, Dice's notes as signals", async () => {
    const s = fakeServer([tool(page([ad(1)]))], { sse: true });
    const r = await dice.search({ what: "backend engineer", where: "Austin, TX" }, opts(s.f));
    expect(s.tools()[0]!.body.params!.arguments).toEqual({ keyword: "backend engineer", location: "Austin, TX", jobs_per_page: 100, page_number: 1 });
    expect(r.jobs).toEqual([
      {
        id: "dice:us:00000001-aaaa-bbbb-cccc-000000000000",
        source: "dice",
        board: "us",
        company: "Acme",
        title: "Job 1",
        locations: ["Austin, Texas, USA"],
        url: "https://www.dice.com/job-detail/00000001-aaaa-bbbb-cccc-000000000000",
        postedAt: "2026-11-26T20:10:23Z",
        updatedAt: "2026-11-28T12:13:48Z",
        pay: [{ min: 120000, max: 150000, currency: "USD", period: "year" }],
        description: "About job 1...",
        companyPage: "https://www.dice.com/company/123",
        companyLogo: "https://example.com/acme.png",
        signals: ["Full-time", "On-Site"],
      },
    ]);
    expect(r.totalAds).toBeUndefined();
    expect(r.query.country).toBe("us");
  });

  test("remote without a place, recruiter and sponsorship notes, pay it can't read kept as written", async () => {
    const s = fakeServer([
      tool(page([ad(2, { jobLocation: null, workplaceTypes: ["Remote"], isRemote: true, employerType: "Recruiter", willingToSponsor: true, salary: "70 - 75", employmentType: "Contract" })])),
    ]);
    const [job] = (await dice.search({ what: "x" }, opts(s.f))).jobs;
    expect(job!.locations).toEqual([]);
    expect(job!.remote).toBe(true);
    expect(job!.pay).toEqual([]);
    expect(job!.description).toBe("About job 2...\n\nPay, as Dice gives it: 70 - 75");
    expect(job!.signals).toEqual(["Contract", "Remote", "Posted by a recruiter", "Willing to sponsor"]);
    expect(s.tools()[0]!.body.params!.arguments!.location).toBeUndefined();
  });

  test("skips entries missing a title or company; one odd entry doesn't lose the rest", async () => {
    const s = fakeServer([tool(page([ad(1), ad(2, { companyName: "" }), ad(3, { title: " " }), { nonsense: true }, ad(5)]))]);
    expect((await dice.search({ what: "x" }, opts(s.f))).jobs.map((j) => j.title)).toEqual(["Job 1", "Job 5"]);
  });

  test("pages up to the limit, says how many more there are, drops repeats", async () => {
    const hundred = (from: number) => Array.from({ length: 100 }, (_, i) => ad(from + i));
    const s = fakeServer([tool(page(hundred(0), 444)), tool(page(hundred(100), 444)), tool(page(hundred(200), 444))]);
    const r = await dice.search({ what: "x", limit: 250 }, opts(s.f));
    expect(r.jobs).toHaveLength(250);
    expect(r.totalAds).toBe(444);
    expect(s.tools().map((c) => c.body.params!.arguments!.page_number)).toEqual([1, 2, 3]);

    const small = fakeServer([tool(page([ad(1), ad(2), ad(3)], 3))]);
    expect((await dice.search({ what: "x", limit: 2 }, opts(small.f))).jobs).toHaveLength(2);
    expect(small.tools()[0]!.body.params!.arguments!.jobs_per_page).toBe(2);

    const repeats = fakeServer([tool(page([ad(1), ad(1), ad(2)], 3))]);
    expect((await dice.search({ what: "x" }, opts(repeats.f))).jobs).toHaveLength(2);
    expect(repeats.tools()).toHaveLength(1);
  });

  test("a place outside the US stops with a reason, instead of showing US remote jobs as its own", async () => {
    const s = fakeServer([tool(page([ad(1)], 6746, "GB"))]);
    const e = await dice.search({ what: "x", where: "London" }, opts(s.f)).catch((x) => x);
    expect(e).toBeInstanceOf(SourceError);
    expect(e.message).toMatch(/only has jobs in the United States, and "London" is in GB/);
    expect((await dice.search({ what: "x", country: "gb" }, opts(fakeServer([]).f)).catch((x) => x)).message).toMatch(/only has jobs in the United States/);
    expect((await dice.search({ what: " " }, opts(fakeServer([]).f)).catch((x) => x)).message).toMatch(/what should we look for/);
  });
});
