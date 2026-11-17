// Smoke test vision (Fase 6, Track C).
// 1. Plumbing end-to-end with a FAKE describeImage: the real screenshot
//    ~/workspace/user/media_library/image/IMG_9782.png (231 KB) is copied
//    into a temp workspace and run through inspect_image.
// 2. Fallback skipping: a non-vision model is skipped, the first vision
//    model answers; all-non-vision fails honestly.
// 3. LIVE call to a real model ONLY when provider keys exist in process.env
//    (never from any file). Without keys, live is reported as NOT TESTED,
//    not as a failure.
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "../src/errors.js";
import type { LlmClient, VisionRequest } from "../src/llm/client.js";
import { createFallbackLlm } from "../src/llm/fallback.js";
import { resolveProviders, type ProviderConfig } from "../src/llm/providers.js";
import { inspectImageTool } from "../src/tools/inspect-image.js";

const REAL_SCREENSHOT = join(
  process.env.HOME ?? "",
  "workspace",
  "user",
  "media_library",
  "image",
  "IMG_9782.png",
);

// 1x1 transparent PNG (fallback fixture if the real screenshot is absent).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

function provider(name: string, model: string): ProviderConfig {
  return {
    name,
    baseUrl: "https://x.test/v1",
    apiKey: "k",
    model,
    inPerM: 0,
    outPerM: 0,
  };
}

async function main(): Promise<void> {
  let pass = true;
  const fail = (msg: string): void => {
    pass = false;
    console.log(`  FAIL: ${msg}`);
  };

  // --- 1. Tool plumbing with the real screenshot (fake vision) ---
  const ws = await mkdtemp(join(tmpdir(), "bikinin-vision-"));
  let shot = "shot.png";
  try {
    await copyFile(REAL_SCREENSHOT, join(ws, "shot.png"));
    console.log("Screenshot asli disalin ke workspace temp (231 KB).");
  } catch {
    await writeFile(join(ws, "shot.png"), PNG_1X1);
    shot = "shot.png (fixture 1x1 — screenshot asli tidak ditemukan)";
    console.log("Screenshot asli tidak ditemukan; pakai fixture PNG 1x1.");
  }
  const seen: VisionRequest[] = [];
  const parsed = inspectImageTool.parse({ path: "shot.png" });
  if (!parsed.ok) {
    fail(`argumen tool ditolak: ${parsed.error}`);
  } else {
    const r = await parsed.execute({
      workspace: ws,
      describeImage: async (req) => {
        seen.push(req);
        return {
          text: "FAKE: screenshot aplikasi — ada tombol biru di bawah.",
          model: "gemini-4-hydrogen",
          provider: "gemini",
        };
      },
    });
    console.log(`Tool plumbing: ok=${r.ok} summary="${r.summary}"`);
    console.log(`  output: ${r.output}`);
    if (!r.ok || !r.output.includes("FAKE:")) fail("output tool tidak sesuai");
    if (seen[0]?.mime !== "image/png") fail("mime tidak diteruskan");
    if (!seen[0]?.imageBase64) fail("base64 tidak diteruskan");
  }

  // --- 2. Fallback skipping + honest error (fake clients) ---
  const fake =
    (calls: string[]) =>
    (p: ProviderConfig): LlmClient => ({
      async chat() {
        throw new Error("tidak dipakai");
      },
      async describeImage(req) {
        calls.push(p.name);
        return { text: `dilihat ${p.name}`, model: req.model ?? p.model };
      },
    });
  const calls: string[] = [];
  const llm = createFallbackLlm(
    [
      provider("or-north", "cohere/north-mini-code:free"),
      provider("or-supervl", "nvidia/nemotron-3.5-super-vl:free"),
      provider("gemini", "gemini-4-hydrogen"),
    ],
    { makeClient: fake(calls) },
  );
  const r = await llm.describeImage({
    imageBase64: "AAAA",
    mime: "image/png",
    prompt: "Apa ini?",
  });
  console.log(
    `Fallback: provider=${r.provider} model=${r.model} calls=${calls.join(",")}`,
  );
  if (r.provider !== "or-supervl" || calls.join(",") !== "or-supervl") {
    fail("fallback tidak melewati model non-vision");
  }
  const noVision = createFallbackLlm(
    [provider("or-north", "cohere/north-mini-code:free")],
    { makeClient: fake([]) },
  );
  try {
    await noVision.describeImage({
      imageBase64: "AAAA",
      mime: "image/png",
      prompt: "Apa ini?",
    });
    fail("seharusnya error jujur saat tak ada model vision");
  } catch (err) {
    console.log(
      `Tanpa model vision: "${err instanceof Error ? err.message : err}"`,
    );
    if (!(err instanceof AgentError)) fail("error bukan AgentError");
  }

  // --- 3. Live call, only with keys from process.env ---
  let providers: ProviderConfig[];
  try {
    providers = resolveProviders(process.env);
  } catch {
    providers = [];
  }
  if (providers.length === 0) {
    console.log("");
    console.log(
      "LIVE: belum diuji (tidak ada provider/key di env — bukan gagal).",
    );
    console.log(
      `  Untuk menguji live: set BIKININ_PROVIDERS + key di env, lalu jalankan lagi; gambar uji: ${shot}.`,
    );
  } else {
    console.log("");
    console.log(
      `LIVE: ${providers.length} provider dari env — memanggil model asli...`,
    );
    const live = createFallbackLlm(providers);
    const bytes = await readFile(join(ws, "shot.png"));
    try {
      const liveResult = await live.describeImage({
        imageBase64: bytes.toString("base64"),
        mime: "image/png",
        prompt:
          "Deskripsikan screenshot ini — apa yang terlihat, ada masalah tampilan/bug?",
      });
      console.log(
        `LIVE OK via ${liveResult.provider} (${liveResult.model}), usage=${JSON.stringify(liveResult.usage)}`,
      );
      console.log(`  ${liveResult.text.slice(0, 500)}`);
    } catch (err) {
      fail(`live call gagal: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("");
  console.log(pass ? "SMOKE PASS" : "SMOKE FAIL");
  if (!pass) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
