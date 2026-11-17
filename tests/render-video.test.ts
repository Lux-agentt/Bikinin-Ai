// Unit tests Fase 3: render_video. The real Remotion binary is never invoked
// here — executeRenderVideo takes an injected exec function, and the stubs
// below write a minimal PNG / dummy MP4 so the verification steps run for real.
// The full end-to-end render (real binary, real MP4) is scripts/smoke-remotion.ts.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLimits,
  maxVideoSeconds,
  parseCompositionsTable,
  executeRenderVideo,
  type CompositionInfo,
} from "../src/tools/render-video.js";
import { runTool, tempWorkspace } from "./helpers.js";

const PNG_SIG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const TABLE_10S = `
The following compositions are available:

Intro    30      1280x720       300 (10.00 sec)
Outro    30      1280x720       150 (5.00 sec)
`;

const INTRO: CompositionInfo = {
  id: "Intro",
  fps: 30,
  width: 1280,
  height: 720,
  frames: 300,
  seconds: 10,
};

interface Call {
  file: string;
  args: string[];
}

interface StubOpts {
  compositions?: string;
  stillOk?: boolean;
  renderOk?: boolean;
  ffprobeJson?: string | null;
  ffprobeMissing?: boolean;
}

function makeStub(opts: StubOpts = {}) {
  const calls: Call[] = [];
  const exec = async (
    file: string,
    args: string[],
    _o: { cwd: string; timeout: number },
  ) => {
    calls.push({ file, args });
    if (file === "ffprobe") {
      if (opts.ffprobeMissing)
        return {
          ok: false,
          killed: false,
          code: 127,
          output: "ffprobe: command not found (ENOENT)",
        };
      return {
        ok: true,
        killed: false,
        code: 0,
        output:
          opts.ffprobeJson ??
          JSON.stringify({
            format: { duration: "10.000000" },
            streams: [{ codec_type: "video" }],
          }),
      };
    }
    if (args.includes("compositions"))
      return {
        ok: true,
        killed: false,
        code: 0,
        output: opts.compositions ?? TABLE_10S,
      };
    if (args.includes("still")) {
      if (opts.stillOk === false)
        return {
          ok: false,
          killed: false,
          code: 1,
          output: "Error: composition failed to render",
        };
      const stillPath = args[args.indexOf("still") + 2];
      await writeFile(stillPath, Buffer.concat([PNG_SIG, Buffer.alloc(2048)]));
      return { ok: true, killed: false, code: 0, output: "still ok" };
    }
    if (args.includes("render")) {
      if (opts.renderOk === false)
        return {
          ok: false,
          killed: false,
          code: 1,
          output: "Error: render failed",
        };
      const outPath = args[args.indexOf("render") + 2];
      await writeFile(outPath, Buffer.alloc(61_260));
      return { ok: true, killed: false, code: 0, output: "render ok" };
    }
    return { ok: true, killed: false, code: 0, output: "" };
  };
  return { calls, exec };
}

async function makeProject(ws: string): Promise<string> {
  const dir = join(ws, "video");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), '{"name":"video"}');
  return dir;
}

describe("parseCompositionsTable", () => {
  it("parses the real remotion table", () => {
    expect(parseCompositionsTable(TABLE_10S)).toEqual([
      INTRO,
      {
        id: "Outro",
        fps: 30,
        width: 1280,
        height: 720,
        frames: 150,
        seconds: 5,
      },
    ]);
  });

  it("ignores junk lines and returns [] on garbage", () => {
    expect(parseCompositionsTable("Bundling code 100%\nnope\n")).toEqual([]);
  });
});

describe("checkLimits", () => {
  it("allows 10 detik 720p, and exactly 30 detik 1280x720", () => {
    expect(checkLimits(INTRO, 30)).toBeNull();
    expect(checkLimits({ ...INTRO, seconds: 30, frames: 900 }, 30)).toBeNull();
  });

  it("rejects duration over the limit", () => {
    expect(checkLimits({ ...INTRO, seconds: 31, frames: 930 }, 30)).toMatch(
      /melebihi batas 30 detik/,
    );
  });

  it("rejects resolution over 720p", () => {
    expect(
      checkLimits({ ...INTRO, width: 1920, height: 1080 }, 30),
    ).toMatch(/melebihi batas 1280x720/);
  });
});

describe("maxVideoSeconds", () => {
  it("defaults to 30 and reads the env var", () => {
    const prev = process.env.BIKININ_MAX_VIDEO_SECONDS;
    try {
      delete process.env.BIKININ_MAX_VIDEO_SECONDS;
      expect(maxVideoSeconds()).toBe(30);
      process.env.BIKININ_MAX_VIDEO_SECONDS = "12";
      expect(maxVideoSeconds()).toBe(12);
      process.env.BIKININ_MAX_VIDEO_SECONDS = "bukan-angka";
      expect(maxVideoSeconds()).toBe(30);
    } finally {
      if (prev === undefined) delete process.env.BIKININ_MAX_VIDEO_SECONDS;
      else process.env.BIKININ_MAX_VIDEO_SECONDS = prev;
    }
  });
});

describe("render_video tool (stubbed exec)", () => {
  it("runs compositions -> still -> render -> ffprobe, in that order", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { calls, exec } = makeStub();
    const r = await executeRenderVideo(
      { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
      { workspace: ws },
      exec,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/out\/video\.mp4 \(10 dtk, 1280x720/);
    expect(r.summary).toMatch(/still frame 150 dicek dulu/);
    expect(r.changes.map((c) => c.path)).toEqual([
      "out/video.mp4",
      "out/video.still.png",
    ]);
    const subs = calls.map((c) =>
      c.args.includes("compositions")
        ? "compositions"
        : c.args.includes("still")
          ? "still"
          : c.args.includes("render")
            ? "render"
            : c.file,
    );
    expect(subs).toEqual(["compositions", "still", "render", "ffprobe"]);
    // The still is taken at the middle frame by default.
    expect(calls[1].args).toContain("--frame=150");
  });

  it("a failed still aborts before the full render", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { calls, exec } = makeStub({ stillOk: false });
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/still frame 150 gagal/);
    expect(calls.some((c) => c.args.includes("render"))).toBe(false);
  });

  it("duration over the limit fails before any still/render", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { calls, exec } = makeStub({
      compositions: "\nLong    30      1280x720       1800 (60.00 sec)\n",
    });
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Long", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/melebihi batas 30 detik/);
    expect(calls).toHaveLength(1); // only the compositions probe ran
  });

  it("resolution over 720p fails before any still/render", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { calls, exec } = makeStub({
      compositions: "\nBig    30      1920x1080       300 (10.00 sec)\n",
    });
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Big", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/melebihi batas 1280x720/);
    expect(calls).toHaveLength(1);
  });

  it("unknown composition fails and lists the available ids", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { exec } = makeStub();
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "TidakAda", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/tidak ditemukan.*Intro, Outro/);
  });

  it("frame out of range fails before rendering", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { calls, exec } = makeStub();
    await expect(
      executeRenderVideo(
        {
          projectDir: "video",
          compositionId: "Intro",
          output: "out/video.mp4",
          frame: 300,
        },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/di luar jangkauan/);
    expect(calls.some((c) => c.args.includes("still"))).toBe(false);
  });

  it("missing package.json fails before any exec", async () => {
    const ws = await tempWorkspace();
    const { calls, exec } = makeStub();
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/bukan project Remotion/);
    expect(calls).toHaveLength(0);
  });

  it("ffprobe without a video stream fails the render", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { exec } = makeStub({
      ffprobeJson: JSON.stringify({
        format: { duration: "10.000000" },
        streams: [{ codec_type: "audio" }],
      }),
    });
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/tidak punya video stream/);
  });

  it("a wrong ffprobe duration fails the render", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { exec } = makeStub({
      ffprobeJson: JSON.stringify({
        format: { duration: "2.000000" },
        streams: [{ codec_type: "video" }],
      }),
    });
    await expect(
      executeRenderVideo(
        { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
        { workspace: ws },
        exec,
      ),
    ).rejects.toThrow(/durasi MP4 .* tidak cocok/);
  });

  it("missing ffprobe falls back to the size check", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    const { exec } = makeStub({ ffprobeMissing: true });
    const r = await executeRenderVideo(
      { projectDir: "video", compositionId: "Intro", output: "out/video.mp4" },
      { workspace: ws },
      exec,
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/ffprobe tidak tersedia/);
  });
});

describe("render_video arg validation (via registry)", () => {
  it("rejects bad ids, non-mp4 output, and path escapes", async () => {
    const ws = await tempWorkspace();
    await makeProject(ws);
    await expect(
      runTool(
        "render_video",
        { compositionId: "Intro; rm -rf /", output: "out/video.mp4" },
        ws,
      ),
    ).rejects.toThrow(/tidak valid/);
    await expect(
      runTool(
        "render_video",
        { compositionId: "Intro", output: "out/video.mov" },
        ws,
      ),
    ).rejects.toThrow(/harus \.mp4/);
    await expect(
      runTool(
        "render_video",
        {
          projectDir: "../keluar",
          compositionId: "Intro",
          output: "out/video.mp4",
        },
        ws,
      ),
    ).rejects.toThrow(/keluar dari workspace/);
    await expect(
      runTool(
        "render_video",
        {
          compositionId: "Intro",
          output: "../keluar.mp4",
        },
        ws,
      ),
    ).rejects.toThrow(/keluar dari workspace/);
  });
});

describe("read_skill remotion", () => {
  it("reads the remotion skill from the repo skills dir", async () => {
    const ws = await tempWorkspace();
    const r = await runTool("read_skill", { name: "remotion" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("# Remotion");
    expect(r.output).toContain("useCurrentFrame");
    expect(r.output).toContain("render_video");
    expect(r.changes).toEqual([]);
  });
});
