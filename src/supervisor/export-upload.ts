import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyExport } from "./git-export.ts";

/**
 * Exports to control, for a rig with no results repository: each export the harness writes
 * leaves the rig as an upload to control, file by file, in pieces control can take back up where
 * they stopped. Control checks every file against the export's manifest and keeps the export only
 * once every file arrived with its SHA-256. Until then the export stays in the outbox.
 *
 * What goes is what a results repository would get: every file of the manifest, and the ledger
 * snapshot at most once a day (and always with a full export).
 */

export interface UploadState {
  /** Exports waiting to go to control, oldest first. */
  queue: string[];
  /** The newest exports control holds in full (at most 50). */
  uploaded: string[];
  lastUploadAt?: string | undefined;
  /** When the last ledger snapshot went. */
  lastLedgerAt?: string | undefined;
  lastError?: string | undefined;
}

export interface UploadConfig {
  rig: string;
  outboxDir: string;
  controlUrl: string;
  controlToken: string;
  fetchImpl?: typeof fetch | undefined;
  /** The ledger snapshot goes at most this often, except with a full export (default a day). */
  ledgerEveryMs?: number | undefined;
  /** Bytes per request (default 8 MiB; control takes at most 16 MiB). */
  chunkBytes?: number | undefined;
  now?: (() => Date) | undefined;
}

/** An export's name, as the harness makes them (control takes no other). */
export const EXPORT_NAME = /^[0-9TZ]{8,20}-[0-9a-f]{8}$/;

/** Control's answer about one export: what it has of each file, and whether it has them all. */
interface Have {
  received: Record<string, number>;
  done: string[];
  complete: boolean;
}

class UploadError extends Error {
  /** True: this export can never go (control refuses it); false: try again later. */
  readonly final: boolean;

  constructor(message: string, final: boolean) {
    super(message);
    this.final = final;
  }
}

async function answer(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 300) };
  }
  // 400: control refuses the request itself, so sending it again would not help. Anything
  // else (control unreachable or restarting, a file whose bytes arrived wrong) is tried again.
  if (res.status >= 400 && res.status !== 409)
    throw new UploadError(
      `${what}: control answered ${res.status}: ${String(body.error ?? "").slice(0, 300)}`,
      res.status === 400,
    );
  return body;
}

/** Sends one export; resolves when control holds all of it, saying whether the ledger went. */
async function uploadOne(cfg: UploadConfig, name: string, ledgerDue: boolean): Promise<boolean> {
  const f = cfg.fetchImpl ?? fetch;
  const dir = join(cfg.outboxDir, name);
  if (!existsSync(dir)) throw new UploadError(`export ${name} is no longer in the outbox`, true);
  const { problems, manifest } = verifyExport(dir);
  if (!manifest) throw new UploadError(`export ${name} refused: ${problems.join("; ")}`, true);
  // The manifest as the harness wrote it (verified above), with its rig and time.
  const raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as unknown;
  const withLedger = ledgerDue || manifest.full === true;
  const rels = Object.keys(manifest.files).filter((rel) => rel !== "ledger.sqlite" || withLedger);
  const files = Object.fromEntries(rels.map((rel) => [rel, statSync(join(dir, rel)).size]));
  const base = `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/exports/${name}`;
  const auth = { authorization: `Bearer ${cfg.controlToken}` };
  const begin = await f(base, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ manifest: raw, files }),
  });
  const started = await answer(begin, `export ${name}`);
  if (begin.status === 409) throw new UploadError(`export ${name}: ${String(started.error)}`, true);
  let have = started as unknown as Have;
  const chunk = cfg.chunkBytes ?? 8 * 1024 * 1024;
  for (const rel of rels) {
    if (have.done.includes(rel)) continue;
    const total = files[rel] as number;
    let offset = Math.min(have.received[rel] ?? 0, total);
    const fd = openSync(join(dir, rel), "r");
    try {
      // At least one request, so an empty file is checked and kept too.
      do {
        const n = Math.min(chunk, total - offset);
        const buf = Buffer.alloc(n);
        let read = 0;
        while (read < n) {
          const got = readSync(fd, buf, read, n - read, offset + read);
          if (got === 0) break;
          read += got;
        }
        if (read !== n)
          throw new UploadError(`export ${name}: ${rel} changed while it was sent`, false);
        const res = await f(`${base}/file?path=${encodeURIComponent(rel)}&offset=${offset}`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/octet-stream" },
          body: new Uint8Array(buf),
        });
        const body = (await answer(res, `export ${name}, ${rel}`)) as {
          received?: number;
          complete?: boolean;
          error?: string;
        };
        if (typeof body.received !== "number")
          throw new UploadError(`export ${name}, ${rel}: control did not say what it has`, false);
        if (res.status === 409 && body.received === offset)
          throw new UploadError(`export ${name}, ${rel}: ${String(body.error)}`, false);
        // 409: control has another amount of this file: go on from there.
        offset = body.received;
        if (body.complete) have = { ...have, complete: true };
      } while (offset < total);
    } finally {
      closeSync(fd);
    }
  }
  if (!have.complete) {
    // Every file is sent: control's own answer says whether it holds them all.
    const check = await f(base, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ manifest: raw, files }),
    });
    const now = (await answer(check, `export ${name}`)) as unknown as Have;
    if (!now.complete)
      throw new UploadError(`export ${name}: control does not hold every file yet`, false);
  }
  return rels.includes("ledger.sqlite");
}

/**
 * One round: the queued exports go to control, oldest first. A failure that may pass (control
 * unreachable, a broken request) ends the round, and the export is tried again next round; one
 * control refuses for good is dropped from the queue, and stays in the outbox.
 */
export async function uploadExportsOnce(
  cfg: UploadConfig,
  state: UploadState,
): Promise<UploadState> {
  const now = cfg.now ?? (() => new Date());
  const next: UploadState = { ...state, queue: [...state.queue], uploaded: [...state.uploaded] };
  while (next.queue.length) {
    const name = next.queue[0] as string;
    if (!EXPORT_NAME.test(name)) {
      next.queue.shift();
      next.lastError = `export ${name.slice(0, 80)} not sent: not an export's name`;
      continue;
    }
    const due =
      !next.lastLedgerAt ||
      now().getTime() - Date.parse(next.lastLedgerAt) >= (cfg.ledgerEveryMs ?? 24 * 3_600_000);
    let ledger: boolean;
    try {
      ledger = await uploadOne(cfg, name, due);
    } catch (err) {
      const why = err instanceof Error ? err.message.slice(0, 600) : String(err);
      if (err instanceof UploadError && err.final) {
        // Control refuses it for good: it stays in the outbox, and the report says why.
        next.queue.shift();
        next.lastError = why;
        continue;
      }
      next.lastError = `upload failed: ${why}`;
      break;
    }
    next.queue.shift();
    next.uploaded = [...next.uploaded, name].slice(-50);
    next.lastUploadAt = now().toISOString();
    if (ledger) next.lastLedgerAt = next.lastUploadAt;
    if (next.lastError?.startsWith("upload failed")) next.lastError = undefined;
  }
  return next;
}
