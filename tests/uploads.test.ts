// Tests for the upload endpoint's multipart parser and storage:
// binary-safe parsing, filename sanitizing, secret-name rejection, caps.
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMultipart,
  sanitizeFilename,
  saveUploads,
  UploadError,
} from "../src/server/uploads.js";

const BOUNDARY = "----test-boundary-1234";

function multipart(
  files: Array<{ filename: string; content: Buffer | string }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        "latin1",
      ),
    );
    chunks.push(Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content));
    chunks.push(Buffer.from("\r\n", "latin1"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, "latin1"));
  return Buffer.concat(chunks);
}

function fakeReq(body: Buffer) {
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

describe("sanitizeFilename", () => {
  it("strips directories and leading dots", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename(".env")).toBe("env");
    expect(sanitizeFilename("foto (1).jpg")).toBe("foto_1_.jpg");
    expect(sanitizeFilename("")).toBe("file");
  });
});

describe("parseMultipart", () => {
  it("keeps binary bytes intact across two files", () => {
    const bin = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x89, 0x50]);
    const parts = parseMultipart(
      multipart([
        { filename: "a.png", content: bin },
        { filename: "b.txt", content: "halo\r\nbaris 2" },
      ]),
      `multipart/form-data; boundary=${BOUNDARY}`,
    );
    expect(parts).toHaveLength(2);
    expect(parts[0].filename).toBe("a.png");
    expect(parts[0].data).toEqual(bin);
    expect(parts[1].data.toString()).toBe("halo\r\nbaris 2");
  });

  it("rejects a file over the 10 MB cap", () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
    expect(() =>
      parseMultipart(
        multipart([{ filename: "big.bin", content: big }]),
        `multipart/form-data; boundary=${BOUNDARY}`,
      ),
    ).toThrowError(UploadError);
  });
});

describe("saveUploads", () => {
  it("stores files under workspace/uploads with exact bytes", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-up-"));
    const workspace = await realpath(base);
    const saved = await saveUploads(
      fakeReq(
        multipart([{ filename: "foto.jpg", content: Buffer.from([1, 2, 3]) }]),
      ),
      workspace,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].path).toMatch(/^uploads\/[a-f0-9]{8}_foto\.jpg$/);
    expect(saved[0].name).toBe("foto.jpg");
    expect(saved[0].bytes).toBe(3);
    expect(await readFile(join(workspace, saved[0].path))).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("neutralizes a traversal filename and rejects secret names", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-up-"));
    const workspace = await realpath(base);
    const saved = await saveUploads(
      fakeReq(
        multipart([
          { filename: "../../etc/passwd", content: "x" },
        ]),
      ),
      workspace,
    );
    expect(saved[0].path).toMatch(/^uploads\/[a-f0-9]{8}_passwd$/);
    await expect(
      saveUploads(
        fakeReq(
          multipart([{ filename: "my-secret.txt", content: "x" }]),
        ),
        workspace,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an empty upload", async () => {
    const base = await mkdtemp(join(tmpdir(), "bikinin-up-"));
    const workspace = await realpath(base);
    await expect(
      saveUploads(fakeReq(Buffer.from("")), workspace),
    ).rejects.toMatchObject({ status: 400 });
  });
});
