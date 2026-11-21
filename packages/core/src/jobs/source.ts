/**
 * A source is one way of reaching jobs. This first kind is a hiring system
 * (ATS): one module reads any company's public board on it, given the
 * board's name ("acme") or a link to it. Never a module for one company.
 *
 * Sources only fetch and reshape; judging jobs happens elsewhere.
 */
import type { BoardResult } from "./job.ts";

export interface FetchOptions {
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Milliseconds before giving up. */
  timeoutMs?: number;
}

export interface BoardSource {
  /** "greenhouse" */
  id: string;
  /** "Greenhouse" */
  name: string;
  /** What to pass: shown in help and errors. */
  boardHint: string;
  /** The board's name from a link to it, or a bare name. Undefined when it isn't one of this source's. */
  parseBoard(input: string): string | undefined;
  fetchBoard(board: string, opts?: FetchOptions): Promise<BoardResult>;
}

export class SourceError extends Error {
  override name = "SourceError";
}

/** Says who we are, so a site can see the traffic and reach the project. No personal details. */
export const USER_AGENT = "open-job-search (+https://github.com/riffnomad/open-job-search)";

/** GET JSON, with a timeout and errors in plain words. 404 comes back as null. */
export async function getJson(url: string, what: string, opts: FetchOptions = {}): Promise<unknown | null> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "it took too long to answer" : (e as Error).message;
    throw new SourceError(`couldn't reach ${what}: ${msg}`);
  }
  if (res.status === 404) return null;
  if (res.status === 429) throw new SourceError(`${what} says we're asking too often. Try again later.`);
  if (!res.ok) throw new SourceError(`${what} answered ${res.status} ${res.statusText}`.trim());
  try {
    return await res.json();
  } catch {
    throw new SourceError(`${what} didn't send valid JSON`);
  }
}

/** A board name as hiring systems use them: letters, digits, - and _. */
export const isBoardName = (s: string): boolean => /^[a-z0-9][a-z0-9_-]*$/i.test(s);

/** The input as a URL, if it is one. Accepts links without https://. */
export function asUrl(input: string): URL | undefined {
  const s = input.trim();
  if (!/[./]/.test(s)) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return undefined;
  }
}
