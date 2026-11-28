import type { BoardSource, SearchSource } from "./source.ts";
import { SourceError } from "./source.ts";
import { adzuna } from "./sources/adzuna.ts";
import { arbeitnow } from "./sources/arbeitnow.ts";
import { ashby } from "./sources/ashby.ts";
import { greenhouse } from "./sources/greenhouse.ts";
import { hackernews } from "./sources/hackernews.ts";
import { lever } from "./sources/lever.ts";
import { linkedin } from "./sources/linkedin.ts";
import { personio } from "./sources/personio.ts";
import { recruitee } from "./sources/recruitee.ts";
import { reed } from "./sources/reed.ts";
import { remoteok } from "./sources/remoteok.ts";
import { remotive } from "./sources/remotive.ts";
import { smartrecruiters } from "./sources/smartrecruiters.ts";
import { teamtailor } from "./sources/teamtailor.ts";
import { usajobs } from "./sources/usajobs.ts";
import { workable } from "./sources/workable.ts";
import { workday } from "./sources/workday.ts";

export * from "./job.ts";
export * from "./html.ts";
export * from "./source.ts";
export * from "./judge.ts";
export * from "./xml.ts";
export { adzuna, arbeitnow, ashby, greenhouse, hackernews, lever, linkedin, personio, recruitee, reed, remoteok, remotive, smartrecruiters, teamtailor, usajobs, workable, workday };

/** Every hiring system we can read, by id. */
export const BOARD_SOURCES: Record<string, BoardSource> = { greenhouse, ashby, lever, smartrecruiters, workable, personio, recruitee, teamtailor, workday };

/**
 * Every job board we can search, by id. Searched by words and place across
 * many companies, unlike hiring systems, which are read one company at a time.
 */
export const SEARCH_SOURCES: Record<string, SearchSource> = { adzuna, remotive, remoteok, arbeitnow, reed, usajobs, hackernews, linkedin };

export function searchSource(id: string): SearchSource {
  const s = SEARCH_SOURCES[id.toLowerCase()];
  if (!s) throw new SourceError(`no job board called "${id}". Job boards: ${Object.keys(SEARCH_SOURCES).join(", ") || "none yet"}`);
  return s;
}

/**
 * Whether a job board can be searched: a board with `optIn` only once the
 * person has switched it on (`jobBoardsOn` in config).
 */
export function isSwitchedOn(source: SearchSource, on: readonly string[]): boolean {
  return !source.optIn || on.includes(source.id);
}

export function boardSource(id: string): BoardSource {
  const s = BOARD_SOURCES[id.toLowerCase()];
  if (!s) throw new SourceError(`no source called "${id}". Sources: ${Object.keys(BOARD_SOURCES).join(", ")}`);
  return s;
}

/** Which source a link belongs to, and the board in it. */
export function sourceForLink(input: string): { source: BoardSource; board: string } | undefined {
  if (!/[./]/.test(input)) return undefined;
  for (const source of Object.values(BOARD_SOURCES)) {
    const board = source.parseBoard(input);
    if (board) return { source, board };
  }
  return undefined;
}
