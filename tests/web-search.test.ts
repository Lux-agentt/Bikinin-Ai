// Fase 8 tests: web_search fallback provider (DuckDuckGo HTML) + one retry
// with backoff, markup failure reported distinctly from "0 results", and the
// secret-like query rejection applying to every provider. All network is
// stubbed; no live call here (live DDG is checked once by hand, see report).
import { describe, expect, it } from "vitest";
import {
  parseDuckDuckGoHtml,
  parseDuckDuckGoLite,
  searchWeb,
} from "../src/tools/web-search.js";

const LITE_FIXTURE = `
<table><tr><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.remotion.dev%2Fdocs%2Frender%2F&amp;rut=abc" class='result-link'>Render your video | Remotion</a>
</td></tr><tr><td class='result-snippet'>
Render a <b>video</b> using render CLI command.
</td></tr></table>`;

const HTML_FIXTURE = `
<div class="result results_links results_links_deep web-result">
<div class="links_main links_deep result__body">
<h2 class="result__title">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=def">Example Page</a>
</h2>
<a class="result__snippet" href="https://example.com/page">Just an example snippet.</a>
</div></div>
<div id="links"></div>`;

// A real results page of a provider that happens to hold no results: it
// still carries the page markers, so it must read as "0 hasil", not a
// markup failure.
const LITE_EMPTY = `<form action="/lite/" method="post"></form><p>No more results</p>`;
const HTML_EMPTY = `<div id="links" class="results"></div>`;

// The page DuckDuckGo actually serves this VM (HTTP 202): a bot challenge
// with no result markers at all. It must read as a markup failure, never
// silently as "0 hasil".
const CHALLENGE_PAGE = `
<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=lite&amp;cc=botnet" method="POST"></form>
<p>This is the Lite version.</p>`;

type StubResponse = {
  ok: boolean;
  status?: number;
  text: () => Promise<string>;
};

function stubFetch(
  handler: (url: string) => StubResponse | Promise<StubResponse> | never,
): typeof fetch {
  return (async (url: unknown) =>
    handler(String(url))) as unknown as typeof fetch;
}

const okHtml = (html: string): StubResponse => ({
  ok: true,
  text: async () => html,
});

describe("parseDuckDuckGoHtml", () => {
  it("judul, URL asli (uddg), dan cuplikan dari endpoint HTML", () => {
    const results = parseDuckDuckGoHtml(HTML_FIXTURE);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Example Page");
    expect(results[0].url).toBe("https://example.com/page");
    expect(results[0].snippet).toContain("Just an example snippet.");
  });

  it("parser Lite dan HTML terpisah: markup HTML tidak dibaca parser Lite", () => {
    expect(parseDuckDuckGoLite(HTML_FIXTURE)).toEqual([]);
    expect(parseDuckDuckGoHtml(LITE_FIXTURE)).toEqual([]);
  });
});

describe("searchWeb fallback", () => {
  it("fallback dipakai saat provider pertama gagal total (throw)", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch((url) => {
      calls.push(url);
      if (url.includes("lite.duckduckgo.com")) throw new Error("ECONNRESET");
      return okHtml(HTML_FIXTURE);
    });
    const results = await searchWeb("example", fetchImpl, { retryDelayMs: 0 });
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/page");
    expect(calls.some((u) => u.includes("html.duckduckgo.com"))).toBe(true);
  });

  it("fallback dipakai saat provider pertama mengembalikan halaman tantangan bot", async () => {
    const fetchImpl = stubFetch((url) =>
      url.includes("lite.duckduckgo.com")
        ? okHtml(CHALLENGE_PAGE)
        : okHtml(HTML_FIXTURE),
    );
    const results = await searchWeb("example", fetchImpl, { retryDelayMs: 0 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Example Page");
  });

  it("hasil provider pertama dipakai bila ada — cadangan tidak dipanggil", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch((url) => {
      calls.push(url);
      return okHtml(LITE_FIXTURE);
    });
    const results = await searchWeb("remotion", fetchImpl, { retryDelayMs: 0 });
    expect(results[0].url).toContain("remotion.dev");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("lite.duckduckgo.com");
  });

  it("retry sekali dengan backoff: gagal sekali lalu berhasil", async () => {
    let liteCalls = 0;
    const fetchImpl = stubFetch((url) => {
      if (url.includes("lite.duckduckgo.com")) {
        liteCalls++;
        if (liteCalls === 1) throw new Error("socket hang up");
      }
      return okHtml(LITE_FIXTURE);
    });
    const results = await searchWeb("remotion", fetchImpl, { retryDelayMs: 0 });
    expect(results).toHaveLength(1);
    expect(liteCalls).toBe(2);
  });

  it("retry hanya sekali per provider: gagal terus → pindah ke cadangan", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch((url) => {
      calls.push(url);
      if (url.includes("lite.duckduckgo.com")) throw new Error("down");
      return okHtml(HTML_FIXTURE);
    });
    const results = await searchWeb("example", fetchImpl, { retryDelayMs: 0 });
    expect(results).toHaveLength(1);
    expect(calls.filter((u) => u.includes("lite.duckduckgo.com"))).toHaveLength(
      2,
    );
    expect(calls.filter((u) => u.includes("html.duckduckgo.com"))).toHaveLength(
      1,
    );
  });

  it("HTTP 503 di-retry, HTTP 404 tidak", async () => {
    let calls = 0;
    const fetch503 = stubFetch(() => {
      calls++;
      return { ok: false, status: 503, text: async () => "" };
    });
    await expect(
      searchWeb("example", fetch503, { retryDelayMs: 0 }),
    ).rejects.toThrow(/pencarian gagal/);
    // 2 attempts Lite + 2 attempts HTML = 4
    expect(calls).toBe(4);

    calls = 0;
    const fetch404 = stubFetch(() => {
      calls++;
      return { ok: false, status: 404, text: async () => "" };
    });
    await expect(
      searchWeb("example", fetch404, { retryDelayMs: 0 }),
    ).rejects.toThrow(/pencarian gagal/);
    // No retry on 404: 1 attempt per provider = 2
    expect(calls).toBe(2);
  });
});

describe("searchWeb: 0 hasil vs markup berubah", () => {
  it("halaman asli yang kosong di kedua provider → [] (0 hasil, bukan error)", async () => {
    const fetchImpl = stubFetch((url) =>
      url.includes("lite.duckduckgo.com")
        ? okHtml(LITE_EMPTY)
        : okHtml(HTML_EMPTY),
    );
    await expect(
      searchWeb("zxqvkjwlrpzznonexistent", fetchImpl, { retryDelayMs: 0 }),
    ).resolves.toEqual([]);
  });

  it("markup berubah di kedua provider → error yang berbeda dari 0 hasil", async () => {
    const fetchImpl = stubFetch(() => okHtml(CHALLENGE_PAGE));
    await expect(
      searchWeb("example", fetchImpl, { retryDelayMs: 0 }),
    ).rejects.toThrow(/format hasil pencarian berubah/);
  });

  it("halaman kosong tanpa penanda apa pun → error markup, bukan []", async () => {
    const fetchImpl = stubFetch(() =>
      okHtml("<html><body>hello</body></html>"),
    );
    await expect(
      searchWeb("example", fetchImpl, { retryDelayMs: 0 }),
    ).rejects.toThrow(/format hasil pencarian berubah/);
  });

  it("satu provider markup-berubah + satu lagi halaman asli kosong → []", async () => {
    const fetchImpl = stubFetch((url) =>
      url.includes("lite.duckduckgo.com")
        ? okHtml(CHALLENGE_PAGE)
        : okHtml(HTML_EMPTY),
    );
    await expect(
      searchWeb("zxqvkjwlrpzznonexistent", fetchImpl, { retryDelayMs: 0 }),
    ).resolves.toEqual([]);
  });
});

describe("searchWeb: penolakan query mirip rahasia", () => {
  it("ditolak sebelum fetch dipanggil — di semua provider (fetch 0 kali)", async () => {
    let called = 0;
    const fetchImpl = stubFetch(() => {
      called++;
      return okHtml(LITE_FIXTURE);
    });
    for (const q of [
      "sk-abcdefghijklmnop123456",
      "api_key=abc123",
      "password: hunter2",
      "ghp_abcdefghijklmnopqrstuvwxyz1234",
    ]) {
      await expect(
        searchWeb(q, fetchImpl, { retryDelayMs: 0 }),
      ).rejects.toThrow(/rahasia/);
    }
    expect(called).toBe(0);
  });
});
