// CLI argument parsing (Fase 1). Pure function, unit-tested in
// tests/cli-args.test.ts. Kept out of cli.ts so tests can import it without
// running main().
//
// Usage:
//   bikinin "pesan" [--json] [--yolo]
//   bikinin --continue [s_xxxxxxxx] "pesan lanjutan" [--json] [--yolo]
// --continue without an id resumes the most recent session.
export interface CliArgs {
  message: string;
  json: boolean;
  yolo: boolean;
  /** "continue" mode: an explicit session id, or null for the latest one. */
  continueSessionId: string | null;
  continueMode: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const words: string[] = [];
  let json = false;
  let yolo = false;
  let continueMode = false;
  let continueSessionId: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--yolo") yolo = true;
    else if (a === "--continue") {
      continueMode = true;
      const next = argv[i + 1];
      if (next && /^s_[a-f0-9]{8}$/.test(next)) {
        continueSessionId = next;
        i++;
      }
    } else if (a.startsWith("--")) {
      throw new Error(`flag tidak dikenal: ${a}`);
    } else {
      words.push(a);
    }
  }
  return {
    message: words.join(" ").trim(),
    json,
    yolo,
    continueSessionId,
    continueMode,
  };
}
