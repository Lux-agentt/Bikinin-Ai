// Small line-based unified diff, no new dependency (Fase 6, diff review).
// Used by the loop to fill the `diff` field of `file_changed` events.
// Bounded by design: at most DIFF_MAX_LINES lines per side take part in
// the LCS, and the rendered diff is truncated to DIFF_MAX_CHARS.
import { truncate } from "../tools/types.js";

export const DIFF_MAX_CHARS = 2000;
export const DIFF_MAX_LINES = 400;
const CONTEXT_LINES = 3;

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline does not create an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** LCS edit script between two (capped) line lists. */
function editScript(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..], suffix table.
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: " ", line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "-", line: oldLines[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: oldLines[i++] });
  while (j < m) ops.push({ kind: "+", line: newLines[j++] });
  return ops;
}

interface Hunk {
  oldStart: number; // 1-based line number in the old file
  oldCount: number;
  newStart: number;
  newCount: number;
  ops: Op[];
}

/** Groups the edit script into hunks: changes separated by more than
 *  2*CONTEXT_LINES of unchanged lines start a new hunk. */
function hunks(ops: Op[]): Hunk[] {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].kind !== " ") changes.push(i);
  if (changes.length === 0) return [];
  // Group changes that are close together.
  const groups: Array<[number, number]> = [];
  let gStart = changes[0];
  let gPrev = changes[0];
  for (const c of changes.slice(1)) {
    if (c - gPrev > 2 * CONTEXT_LINES) {
      groups.push([gStart, gPrev]);
      gStart = c;
    }
    gPrev = c;
  }
  groups.push([gStart, gPrev]);
  // Line numbers before each op index.
  const oldAt = (idx: number): number => {
    let n = 1;
    for (let i = 0; i < idx; i++) if (ops[i].kind !== "+") n++;
    return n;
  };
  const newAt = (idx: number): number => {
    let n = 1;
    for (let i = 0; i < idx; i++) if (ops[i].kind !== "-") n++;
    return n;
  };
  return groups.map(([first, last]) => {
    const start = Math.max(0, first - CONTEXT_LINES);
    const end = Math.min(ops.length, last + CONTEXT_LINES + 1);
    const slice = ops.slice(start, end);
    return {
      oldStart: oldAt(start),
      oldCount: slice.filter((o) => o.kind !== "+").length,
      newStart: newAt(start),
      newCount: slice.filter((o) => o.kind !== "-").length,
      ops: slice,
    };
  });
}

/**
 * Unified diff of two file contents, truncated to DIFF_MAX_CHARS.
 * Empty string when the contents are identical. Old content "" means
 * the file is new (every line is an addition); new content "" means deleted.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  path: string,
): string {
  if (oldText === newText) return "";
  const oldLines = splitLines(oldText).slice(0, DIFF_MAX_LINES);
  const newLines = splitLines(newText).slice(0, DIFF_MAX_LINES);
  const hs = hunks(editScript(oldLines, newLines));
  const parts = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of hs) {
    parts.push(
      `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`,
    );
    for (const op of h.ops) parts.push(`${op.kind}${op.line}`);
  }
  if (
    splitLines(oldText).length > DIFF_MAX_LINES ||
    splitLines(newText).length > DIFF_MAX_LINES
  ) {
    parts.push(`...[diff dipotong: file lebih dari ${DIFF_MAX_LINES} baris]`);
  }
  return truncate(parts.join("\n"), DIFF_MAX_CHARS).text;
}
