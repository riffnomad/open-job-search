import { describe, expect, test } from "bun:test";

describe("job board helpers", () => {
  test("hasAllWords wants every word, whole, in any case", async () => {
    const { hasAllWords } = await import("../src/index.ts");
    const m = hasAllWords("data  Engineer");
    expect(m("Senior Data Engineer")).toBe(true);
    expect(m("Data Engineering Lead")).toBe(false);
    expect(m("Engineer, Platform")).toBe(false);
    expect(hasAllWords("c++")("C++ Developer")).toBe(true);
    expect(hasAllWords("node.js")("Node.js / React")).toBe(true);
  });

  test("getJsonOnce asks once for the same feed, and again after a failure", async () => {
    const { getJsonOnce } = await import("../src/index.ts");
    let calls = 0;
    let fail = true;
    const f = (async () => {
      calls++;
      if (fail) return new Response("", { status: 500 });
      return new Response("[1]", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(getJsonOnce("https://acme.example/feed", "Acme", { fetch: f })).rejects.toThrow();
    fail = false;
    expect(await getJsonOnce("https://acme.example/feed", "Acme", { fetch: f })).toEqual([1]);
    expect(await getJsonOnce("https://acme.example/feed", "Acme", { fetch: f })).toEqual([1]);
    expect(calls).toBe(2);
  });
});

describe("getJson headers", () => {
  test("adds a source's headers to ours", async () => {
    const { getJson, USER_AGENT } = await import("../src/index.ts");
    let seen: Record<string, string> = {};
    const f = (async (_: string | URL | Request, init?: RequestInit) => {
      seen = init?.headers as Record<string, string>;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await getJson("https://acme.example/api", "Acme", { fetch: f }, { authorization: "Basic abc" });
    expect(seen).toMatchObject({ "user-agent": USER_AGENT, accept: "application/json", authorization: "Basic abc" });
  });
});
