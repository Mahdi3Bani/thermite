import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { SignedCommand } from "../../src/core/commands.ts";
import {
  downloadModel,
  ModelDownloadError,
  ModelDownloads,
  ModelRefused,
} from "../../src/supervisor/model-download.ts";
import { stageCommand } from "../../src/supervisor/staging.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "thermite-models-"));
  const inbox = join(root, "inbox");
  mkdirSync(inbox);
  const lines: string[] = [];
  const downloads = new ModelDownloads({ live: (text) => lines.push(text) });
  return { root, inbox, lines, downloads };
}

/** Every file under a folder, with its bytes. */
function everyFile(dir: string): { path: string; bytes: Buffer }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return { path, bytes: readFileSync(path) };
    });
}

describe("model files by URL", () => {
  test("a file whose SHA-256 is not the signed one is refused, deleted, and says so", async () => {
    const { inbox, lines, downloads } = setup();
    const bytes = Buffer.from("not the model you signed ".repeat(100));
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array(bytes), {
        headers: { "content-length": String(bytes.length) },
      });
    const target = join(inbox, "models", "m.bin");
    await assert.rejects(
      downloadModel({
        url: "https://models.example.com/m.bin?sig=abc",
        sha256: "0".repeat(64),
        target,
        path: "models/m.bin",
        name: "m",
        downloads,
        fetchImpl,
      }),
      (err: unknown) =>
        err instanceof ModelRefused &&
        err.message.includes(`its SHA-256 is ${sha(bytes)}, not the signed ${"0".repeat(64)}`) &&
        err.message.includes("The file was deleted") &&
        !err.message.includes("sig=abc"),
    );
    assert.ok(!existsSync(target), "a wrong file never lands");
    assert.ok(!existsSync(`${target}.part`), "and nothing of it stays");
    const [p] = downloads.list();
    assert.equal(p?.state, "refused");
    assert.equal(p?.from, "models.example.com");
    assert.match(String(p?.error), /Its SHA-256 is [0-9a-f]{64}, not the signed 0{64}/);
    assert.match(lines.at(-1) ?? "", /^Model m: refused\. .* The file was deleted\.$/);
  });

  test("progress is in the report and the live view, and a broken download continues where it stopped", async () => {
    const { inbox, lines, downloads } = setup();
    const bytes = Buffer.alloc(1_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const ranges: (string | undefined)[] = [];
    let first = true;
    const server = createServer((req, res) => {
      ranges.push(req.headers.range);
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (first) {
        // The first answer breaks after 400 kB, as a dropped connection does.
        first = false;
        res.writeHead(200, { "content-length": String(bytes.length) });
        res.write(bytes.subarray(0, 400_000), () => setTimeout(() => res.socket?.destroy(), 50));
        return;
      }
      const from = m ? Number(m[1]) : 0;
      res.writeHead(m ? 206 : 200, {
        "content-length": String(bytes.length - from),
        ...(m ? { "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}),
      });
      // In ten pieces, so the progress moves in steps.
      let at = from;
      const step = () => {
        if (at >= bytes.length) return res.end();
        const next = Math.min(bytes.length, at + 60_000);
        res.write(bytes.subarray(at, next), () => setTimeout(step, 2));
        at = next;
      };
      step();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.bin`;
    const target = join(inbox, "models", "big.bin");
    const input = {
      url,
      sha256: sha(bytes),
      target,
      path: "models/big.bin",
      name: "big",
      run: "run-1",
      downloads,
    };
    try {
      await assert.rejects(downloadModel(input), /the download broke after .* The next try/);
      assert.equal(downloads.list()[0]?.state, "failed");
      const kept = statSync(`${target}.part`).size;
      assert.ok(kept > 0 && kept < bytes.length, `a part is kept (${kept} bytes)`);
      // While it runs, the report shows how far it got.
      const seen: { bytes: number; total: number | null; state: string }[] = [];
      const watching = new ModelDownloads({
        live: (text) => {
          lines.push(text);
          const p = watching.list()[0];
          if (p) seen.push({ bytes: p.bytes, total: p.total, state: p.state });
        },
      });
      await downloadModel({ ...input, downloads: watching });
      assert.deepEqual(readFileSync(target), bytes);
      assert.ok(!existsSync(`${target}.part`));
      assert.equal(ranges[1], `bytes=${kept}-`, "the second try asks for the rest only");
      const p = watching.list()[0];
      assert.equal(p?.state, "done");
      assert.equal(p?.bytes, bytes.length);
      assert.equal(p?.total, bytes.length);
      assert.equal(p?.resumed_from, kept);
      assert.equal(p?.run, "run-1");
      const mid = seen.filter((s) => s.state === "downloading" && s.bytes < bytes.length);
      assert.ok(mid.length >= 3, "the report moves while it downloads");
      assert.ok(mid.every((s) => s.total === bytes.length));
      assert.ok(
        lines.some((l) =>
          /^Model big: download started from 127\.0\.0\.1:\d+, 1 MB, from the \d+ bytes an earlier download left\.$/.test(
            l,
          ),
        ),
      );
      assert.ok(lines.some((l) => /^Model big: \d+ bytes of 1 MB \(\d+%\) downloaded\.$/.test(l)));
      assert.equal(lines.at(-1), "Model big: 1 MB downloaded. Its SHA-256 matches the signed one.");
    } finally {
      server.close();
    }
  });

  test("a Hugging Face token goes to Hugging Face only, never into a file, a line, the report or an error", async () => {
    const { root, inbox, lines, downloads } = setup();
    const token = "hf_madeUpTokenForTheTest";
    const bytes = Buffer.from("gated weights ".repeat(500));
    const calls: { url: string; auth: string | null }[] = [];
    let gated = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url, auth });
      const u = new URL(url);
      if (u.hostname === "huggingface.co") {
        // A server that echoes what it got must not put the token anywhere either.
        if (gated) return new Response(`denied for ${auth}`, { status: 403 });
        return new Response(null, {
          status: 302,
          headers: { location: "https://cas-bridge.files.example/xet/abc?X-Signature=s3cr3t" },
        });
      }
      return new Response(new Uint8Array(bytes), {
        headers: { "content-length": String(bytes.length) },
      });
    };
    const model = {
      kind: "model",
      path: `models/${sha(bytes)}`,
      name: "gated-7b",
      sha256: sha(bytes),
      source: { url: "https://huggingface.co/org/gated-7b/resolve/0123abcd/model.safetensors" },
    };
    const cmd = (id: string) =>
      ({
        envelope: {
          v: 1,
          id,
          rig: "rig-a",
          kind: "assign_campaign",
          issued_by: "owner:api",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: { run: "run-1", imports: [model] },
        },
        signature: "",
      }) as unknown as SignedCommand;
    const cfg = {
      rig: "rig-a",
      inboxDir: inbox,
      resultsRepo: join(root, "home", "results.git"),
      models: downloads,
      hfToken: token,
      fetchImpl,
    };
    const staged = async (c: SignedCommand) => {
      for (let i = 0; i < 200; i++) {
        const r = await stageCommand(cfg, c);
        if (r !== "wait") return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error("staging never finished");
    };
    assert.equal(await staged(cmd("c-1")), "ready");
    assert.deepEqual(readFileSync(join(inbox, model.path)), bytes);
    // Only Hugging Face's own address got the token; its file server got none.
    assert.deepEqual(
      calls.map((c) => [new URL(c.url).hostname, c.auth]),
      [
        ["huggingface.co", `Bearer ${token}`],
        ["cas-bridge.files.example", null],
      ],
    );
    // A gated file the token may not read: the error says what to do, and holds no token.
    gated = true;
    const other = { ...model, path: "models/other", sha256: "1".repeat(64) };
    const refused = await (async () => {
      const c = cmd("c-2");
      (c.envelope.payload as { imports: unknown[] }).imports = [other];
      return staged(c);
    })();
    assert.match(
      JSON.stringify(refused),
      /HTTP 403: Hugging Face refused the supervisor's token for this file/,
    );
    const everything = [
      JSON.stringify(refused),
      JSON.stringify(downloads.list()),
      ...lines,
      ...everyFile(inbox).map((f) => `${f.path}\n${f.bytes.toString("latin1")}`),
    ].join("\n");
    assert.ok(!everything.includes(token), "the token is in nothing a role or control can read");
    assert.ok(!everything.includes("s3cr3t"), "nor is a signed address's query");
    assert.ok(
      downloads.list().some((p) => p.from === "huggingface.co (via cas-bridge.files.example)"),
    );
  });

  test("without the space for it, nothing is downloaded", async () => {
    const { inbox, downloads } = setup();
    let cancelled = false;
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(ctl) {
            ctl.enqueue(new Uint8Array(1000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "5000000000" } },
      );
    const target = join(inbox, "models", "huge.bin");
    await assert.rejects(
      downloadModel({
        url: "https://models.example.com/huge.bin",
        sha256: "2".repeat(64),
        target,
        path: "models/huge.bin",
        name: "huge",
        downloads,
        fetchImpl,
        free: () => 1_000_000_000,
      }),
      (err: unknown) =>
        err instanceof ModelDownloadError &&
        /not enough free space for model huge: it needs 5\.0 GB more, and 1\.0 GB is free where it goes \(the inbox's models\)/.test(
          err.message,
        ),
    );
    assert.ok(cancelled, "the answer is dropped unread");
    assert.ok(!existsSync(`${target}.part`));
    assert.equal(downloads.list()[0]?.state, "failed");
  });

  test("a redirect from HTTPS to plain HTTP is refused, and never followed", async () => {
    const { inbox, downloads } = setup();
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(null, {
        status: 301,
        headers: { location: "http://plain.example.com/model.bin" },
      });
    };
    await assert.rejects(
      downloadModel({
        url: "https://huggingface.co/org/m/resolve/main/model.bin",
        sha256: "3".repeat(64),
        target: join(inbox, "m.bin"),
        path: "m.bin",
        name: "m",
        hfToken: "hf_anotherMadeUpToken",
        downloads,
        fetchImpl,
      }),
      /a redirect from HTTPS to plain HTTP is refused/,
    );
    assert.deepEqual(asked, ["https://huggingface.co/org/m/resolve/main/model.bin"]);
  });
});
