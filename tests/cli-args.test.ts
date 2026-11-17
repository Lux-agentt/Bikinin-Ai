import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";

describe("parseCliArgs", () => {
  it("parses a plain message", () => {
    expect(parseCliArgs(["buatkan", "landing", "page"])).toMatchObject({
      message: "buatkan landing page",
      json: false,
      yolo: false,
      continueMode: false,
      continueSessionId: null,
    });
  });

  it("parses --json and --yolo anywhere", () => {
    const a = parseCliArgs(["--yolo", "kerjakan", "--json"]);
    expect(a.yolo).toBe(true);
    expect(a.json).toBe(true);
    expect(a.message).toBe("kerjakan");
  });

  it("parses --continue with an explicit session id", () => {
    const a = parseCliArgs(["--continue", "s_abcdef12", "lanjutkan"]);
    expect(a.continueMode).toBe(true);
    expect(a.continueSessionId).toBe("s_abcdef12");
    expect(a.message).toBe("lanjutkan");
  });

  it("parses bare --continue as 'latest session'", () => {
    const a = parseCliArgs(["--continue", "lanjutkan"]);
    expect(a.continueMode).toBe(true);
    expect(a.continueSessionId).toBeNull();
    expect(a.message).toBe("lanjutkan");
  });

  it("does not swallow a message word that looks almost like an id", () => {
    const a = parseCliArgs(["--continue", "s_zzzz", "halo"]);
    expect(a.continueSessionId).toBeNull();
    expect(a.message).toBe("s_zzzz halo");
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--nope", "halo"])).toThrow(
      "flag tidak dikenal",
    );
  });
});
