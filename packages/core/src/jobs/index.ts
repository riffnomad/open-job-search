import type { BoardSource } from "./source.ts";
import { SourceError } from "./source.ts";
import { greenhouse } from "./sources/greenhouse.ts";

export * from "./job.ts";
export * from "./html.ts";
export * from "./source.ts";
export * from "./judge.ts";
export { greenhouse };

/** Every hiring system we can read, by id. */
export const BOARD_SOURCES: Record<string, BoardSource> = { greenhouse };

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
