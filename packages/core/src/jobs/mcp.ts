/**
 * Just enough of an MCP client to call a tool on a job board's own MCP
 * server, over Streamable HTTP (modelcontextprotocol.io, protocol 2025-06-18):
 * start a session, then call tools. ojs is the client, so the person's agent
 * never has to load these servers, restart, or spend its context on them.
 *
 * A server's replies are data, like any page we read. Tool descriptions can
 * carry instructions written for an AI; we read them when building a source,
 * and nothing here follows them.
 */
import { z } from "zod";
import { type FetchOptions, sendRequest, SourceError } from "./source.ts";

const PROTOCOL = "2025-06-18";
const CLIENT = { name: "open-job-search", version: "0.1.0" };

/** The server wants the person signed in for this: it isn't free to everyone. */
export class SignInNeeded extends SourceError {
  override name = "SignInNeeded";
}

export interface McpSession {
  /** A tool's result: its structured content, or its text read as JSON. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const Message = z.object({
  id: z.union([z.number(), z.string()]).nullish(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().nullish() }).passthrough().nullish(),
});

const ToolResult = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().nullish() }).passthrough()).nullish(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().nullish(),
});

/** The JSON-RPC messages in a reply: one JSON body, or a stream of server-sent events. */
function messagesIn(body: string, type: string): unknown[] {
  if (!/text\/event-stream/i.test(type)) {
    const one = JSON.parse(body) as unknown;
    return Array.isArray(one) ? one : [one];
  }
  const out: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) out.push(JSON.parse(data));
  }
  return out;
}

/** The first line of a server's error, kept short: enough to say what went wrong. */
const firstLine = (s: string) => {
  const line = s.trim().split(/\r?\n/)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

export async function connectMcp(url: string, what: string, opts: FetchOptions = {}): Promise<McpSession> {
  let session: string | undefined;
  let nextId = 1;

  async function post(body: object): Promise<Response> {
    const res = await sendRequest(url, what, opts, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      unauthorized: () => new SignInNeeded(`${what} wants you signed in for that (401); without signing in, it isn't free.`),
    });
    if (!res) throw new SourceError(`${what} isn't there (404). Its MCP server may have moved.`);
    return res;
  }

  async function rpc(method: string, params: object): Promise<unknown> {
    const id = nextId++;
    const res = await post({ id, method, params });
    session ??= res.headers.get("mcp-session-id") ?? undefined;
    let messages: unknown[];
    try {
      messages = messagesIn(await res.text(), res.headers.get("content-type") ?? "");
    } catch {
      throw new SourceError(`${what} sent a reply we couldn't read`);
    }
    // A stream can carry the server's own notes before the answer; ours is the one with our id.
    for (const m of messages) {
      const msg = Message.safeParse(m);
      if (!msg.success || msg.data.id !== id) continue;
      if (msg.data.error) throw new SourceError(`${what} said no: ${firstLine(msg.data.error.message ?? "no reason given")}`);
      return msg.data.result;
    }
    throw new SourceError(`${what} didn't answer our request`);
  }

  await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
  await post({ method: "notifications/initialized" });

  return {
    async callTool(name, args) {
      const parsed = ToolResult.safeParse(await rpc("tools/call", { name, arguments: args }));
      if (!parsed.success) throw new SourceError(`${what} sent a tool result in a shape we don't recognise`);
      const text = (parsed.data.content ?? []).map((c) => c.text ?? "").join("\n");
      if (parsed.data.isError) throw new SourceError(`${what} couldn't do that: ${firstLine(text || "no reason given")}`);
      if (parsed.data.structuredContent !== undefined) return parsed.data.structuredContent;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new SourceError(`${what} didn't send valid JSON`);
      }
    },
  };
}
