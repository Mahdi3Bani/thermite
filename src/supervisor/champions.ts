import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "../common/env.ts";
import { buildHeaders } from "../core/version.ts";

const run = promisify(execFile);

/**
 * Champions' patches go to control, so an operator can download a run's result from the
 * dashboard. The harness exports each published champion as champions/<run>/<seq>.patch; the
 * supervisor commits it to its results repository and uploads it from there. Control keeps it
 * only if its sha256 is the one in the rig's signed champion_published event.
 */
export interface ChampionUpload {
  run: string;
  seq: number;
  path: string;
}

/** The champion patches in exports just written, from their manifests. */
export function championsIn(outboxDir: string, exports: string[]): ChampionUpload[] {
  const out: ChampionUpload[] = [];
  for (const name of exports) {
    const manifest = join(outboxDir, name, "manifest.json");
    if (!existsSync(manifest)) continue;
    const files = (JSON.parse(readFileSync(manifest, "utf8")) as { files?: object }).files ?? {};
    for (const path of Object.keys(files)) {
      const m = /^champions\/([^/]+)\/(\d+)\.patch$/.exec(path);
      if (m) out.push({ run: m[1] as string, seq: Number(m[2]), path });
    }
  }
  return out;
}

/**
 * Uploads queued champion patches; returns the ones to try again: control has not received
 * the rig's champion_published event yet, or the upload failed.
 */
export async function uploadChampions(
  cfg: {
    rig: string;
    controlUrl: string;
    controlToken: string;
    /** The supervisor's results repository, where the exporter committed the patches. */
    resultsRepo: string;
    fetchImpl?: typeof fetch | undefined;
  },
  queue: ChampionUpload[],
): Promise<ChampionUpload[]> {
  const f = cfg.fetchImpl ?? fetch;
  const again: ChampionUpload[] = [];
  for (const c of queue) {
    try {
      const { stdout } = await run(
        "git",
        ["-C", cfg.resultsRepo, "show", `refs/heads/thermite/${cfg.rig}/attempts:${c.path}`],
        { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      );
      const res = await f(
        `${cfg.controlUrl}/v1/rigs/${encodeURIComponent(cfg.rig)}/champions/${encodeURIComponent(c.run)}/${c.seq}/patch`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.controlToken}`,
            "content-type": "application/octet-stream",
            ...buildHeaders(),
          },
          body: new Uint8Array(stdout),
        },
      );
      if (res.status === 201) {
        log("supervisor", "champion patch uploaded", { run: c.run, seq: c.seq });
      } else if (res.status === 422) {
        log("supervisor", "control refused a champion patch", {
          run: c.run,
          seq: c.seq,
          error: (await res.text()).slice(0, 300),
        });
      } else {
        again.push(c);
      }
    } catch (err) {
      log("supervisor", "champion upload error", { run: c.run, seq: c.seq, error: String(err) });
      again.push(c);
    }
  }
  return again;
}
