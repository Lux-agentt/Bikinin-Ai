// Smoke test Fase 3: perintah "buat video 10 detik intro dengan teks animasi"
// dijalankan end-to-end oleh agent dengan fake LLM scripted (deterministik),
// tapi render-nya BENAR-BENAR dijalankan (npm install + npx remotion still +
// npx remotion render + ffprobe). Yang dibuktikan: wiring (agent membaca skill
// remotion dulu, menulis project, lalu render_video menghasilkan MP4 valid).
// Bukan penilaian model live — itu butuh provider terkonfigurasi.
//
// Catatan disk: workspace smoke dibuat di home, BUKAN /tmp (/tmp hanya 512 MB
// dan node_modules + cache bundling Remotion melebihinya). Dihapus di finally.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../src/agent/loop.js";
import { createEmitter, type AgentEvent } from "../src/events.js";
import type { ChatResult, LlmClient, ToolCallReq } from "../src/llm/client.js";
import { loadSystemPrompt } from "../src/prompt.js";
import {
  formatSkillList,
  listSkills,
  REPO_SKILLS_DIR,
} from "../src/skills/loader.js";

const usage = { input_tokens: 100, output_tokens: 20, cached_tokens: 0 };

function call(id: string, name: string, args: unknown): ToolCallReq {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scripted(responses: ChatResult[]): LlmClient {
  let i = 0;
  return {
    async chat(p) {
      const r = responses[i++];
      if (!r) throw new Error("skrip habis");
      if (r.text) p.onText?.(r.text);
      return r;
    },
  };
}

const withCalls = (...toolCalls: ToolCallReq[]): ChatResult => ({
  text: "",
  toolCalls,
  usage,
});
const finalText = (text: string): ChatResult => ({ text, toolCalls: [], usage });

const PACKAGE_JSON = `{
  "name": "intro-video",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@remotion/cli": "4.0.544",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "remotion": "4.0.544"
  }
}
`;

const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "jsx": "react-jsx",
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src"]
}
`;

const REMOTION_CONFIG = `import { Config } from "@remotion/cli/config";
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
`;

const INDEX_TS = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;

// Sama seperti contoh di skills/remotion/SKILL.md (sudah terbukti render).
const ROOT_TSX = `import { AbsoluteFill, Composition, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const scale = spring({ frame, fps, config: { damping: 100 } });
  const slide = interpolate(frame, [durationInFrames - 30, durationInFrames], [0, -80], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#05060b", justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity, transform: \`scale(\${scale}) translateY(\${slide}px)\`, color: "#fff", fontSize: 90, fontFamily: "sans-serif", fontWeight: 800 }}>
        Halo, ini intro!
      </div>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition id="Intro" component={Intro} durationInFrames={300} fps={30} width={1280} height={720} />
    </>
  );
};
`;

function ffprobeJson(file: string): Promise<{
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
}> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        file,
      ],
      { timeout: 60_000 },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(JSON.parse(stdout) as never);
      },
    );
  });
}

async function main(): Promise<void> {
  // Di home, bukan /tmp (lihat catatan di atas).
  const workspace = await mkdtemp(join(homedir(), ".bikinin-smoke-remotion-"));
  const events: AgentEvent[] = [];
  const emit = createEmitter("run_smoke", (e) => events.push(e));
  const started = Date.now();
  try {
    const systemPrompt = await loadSystemPrompt(
      formatSkillList(await listSkills(REPO_SKILLS_DIR)),
    );
    await runAgent({
      llm: scripted([
        withCalls(call("c1", "read_skill", { name: "remotion" })),
        withCalls(
          call("c2", "write_file", { path: "package.json", content: PACKAGE_JSON }),
          call("c3", "write_file", { path: "tsconfig.json", content: TSCONFIG_JSON }),
          call("c4", "write_file", { path: "remotion.config.ts", content: REMOTION_CONFIG }),
          call("c5", "write_file", { path: "src/index.ts", content: INDEX_TS }),
          call("c6", "write_file", { path: "src/Root.tsx", content: ROOT_TSX }),
        ),
        withCalls(
          call("c7", "run_command", {
            command:
              "npm install remotion@4.0.544 @remotion/cli@4.0.544 react@18.3.1 react-dom@18.3.1 --no-audit --no-fund",
          }),
        ),
        withCalls(
          call("c8", "render_video", {
            projectDir: ".",
            compositionId: "Intro",
            output: "out/video.mp4",
          }),
        ),
        finalText("Selesai: video intro 10 detik sudah jadi."),
      ]),
      model: "smoke-model",
      systemPrompt,
      message: "Buat video 10 detik intro dengan teks animasi",
      sessionId: "s_smoke_remotion",
      workspace,
      limits: { maxSteps: 30, maxCostUsd: 1 },
      prices: { inPerM: 1, outPerM: 2 },
      emit,
      approve: async () => true, // smoke: izinkan npm install (di luar allowlist)
    });

    const toolOrder = events
      .filter((e) => e.type === "tool_call_started")
      .map((e) => (e as { tool: string }).tool);
    console.log("Urutan tool:", toolOrder.join(" -> "));

    let pass = true;
    const check = (label: string, ok: boolean, extra = "") => {
      if (!ok) pass = false;
      console.log(`  ${ok ? "YA " : "TIDAK"} ${label}${extra ? ` — ${extra}` : ""}`);
    };

    check(
      "read_skill(remotion) dipanggil sebelum write_file",
      toolOrder[0] === "read_skill" &&
        toolOrder.indexOf("read_skill") < toolOrder.indexOf("write_file"),
    );
    check(
      "render_video dipanggil setelah npm install",
      toolOrder.indexOf("render_video") > toolOrder.indexOf("run_command"),
    );

    // Still frame: PNG valid.
    const stillPath = join(workspace, "out", "video.still.png");
    const stillBytes = await readFile(stillPath);
    const pngSig = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    check(
      "still frame ada dan PNG valid",
      stillBytes.length > 1024 && stillBytes.subarray(0, 8).equals(pngSig),
      `${stillBytes.length} B`,
    );

    // MP4: ffprobe — durasi ~10 dtk, ada video stream h264 1280x720.
    const mp4Path = join(workspace, "out", "video.mp4");
    const { size } = await stat(mp4Path);
    const probe = await ffprobeJson(mp4Path);
    const video = (probe.streams ?? []).find((s) => s.codec_type === "video");
    const duration = Number(probe.format?.duration ?? NaN);
    check(
      "MP4 ada dan ukuran wajar",
      size > 10_000,
      `${(size / 1024).toFixed(1)} KB`,
    );
    check(
      "MP4 punya video stream h264 1280x720",
      video?.codec_name === "h264" && video.width === 1280 && video.height === 720,
      video ? `${video.codec_name} ${video.width}x${video.height}` : "tidak ada",
    );
    check(
      "durasi MP4 ~10 detik",
      Math.abs(duration - 10) < 0.6,
      `${duration} dtk`,
    );

    console.log("");
    console.log(`Total waktu smoke: ${((Date.now() - started) / 1000).toFixed(0)} dtk`);
    console.log(
      pass
        ? "SMOKE PASS: perintah intro 10 detik menghasilkan MP4 yang valid (still dicek dulu)."
        : "SMOKE FAIL: lihat baris di atas.",
    );
    if (!pass) process.exitCode = 1;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
