import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../core/canonical.ts";
import { patchBytes } from "./git.ts";
import type { Ledger } from "./ledger.ts";
import { championFiles } from "./propagation.ts";

/**
 * Outbox export. The harness has no git credentials and no remote access: it writes exports
 * into the shared outbox, and the supervisor pushes them to the results repository as packed
 * commits. An export holds patches and manifests for attempts recorded since the last export,
 * the events since then, a consistent ledger snapshot, and each new instance champion as a patch
 * against its seed (what other units need to judge it themselves).
 */

export interface ExportResult {
  id: number;
  dir: string;
  attempts: number;
  events: number;
}

export async function writeExport(input: {
  ledger: Ledger;
  mirrorFor: (repo: string) => string;
  outboxDir: string;
  unit: string;
  actor: string;
  /** A full export (before a full reset): also the research archive, marked in the manifest. */
  full?: boolean | undefined;
  researchDir?: string | undefined;
}): Promise<ExportResult> {
  const { ledger } = input;
  const since = ledger.lastExport()?.through_event ?? 0;
  const through = ledger.latestEventId();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "");
  const name = `${stamp}-${randomUUID().slice(0, 8)}`;
  const tmp = join(input.outboxDir, `.tmp-${name}`);
  const final = join(input.outboxDir, name);
  mkdirSync(join(tmp, "attempts"), { recursive: true });
  try {
    const events = ledger
      .eventsAfter(since, Number.MAX_SAFE_INTEGER)
      .events.filter((e) => e.id <= through);
    writeFileSync(
      join(tmp, "events.jsonl"),
      events.map((e) => canonicalJson(e)).join("\n") + (events.length ? "\n" : ""),
    );

    const attemptIds = [
      ...new Set(events.filter((e) => e.kind === "attempt_recorded").map((e) => String(e.subject))),
    ];
    for (const id of attemptIds) {
      const a = ledger.getAttempt(id);
      if (!a) continue;
      const instance = ledger.getInstance(String(a.instance));
      const mirror = input.mirrorFor(instance?.seed_repo ?? "");
      const patch = await patchBytes(mirror, String(a.parent_commit), String(a.commit_sha));
      writeFileSync(join(tmp, "attempts", `${id}.patch`), patch);
      writeFileSync(
        join(tmp, "attempts", `${id}.json`),
        `${canonicalJson({ attempt: a, verdict: ledger.currentVerdict(id) ?? null })}\n`,
      );
    }

    const championRel: string[] = [];
    const published = await championFiles({
      ledger,
      mirrorFor: input.mirrorFor,
      write: (rel, data) => {
        mkdirSync(dirname(join(tmp, rel)), { recursive: true });
        writeFileSync(join(tmp, rel), data);
        championRel.push(rel);
      },
    });

    // A full export keeps what a wipe would otherwise destroy: the archived research sources.
    const researchRel: string[] = [];
    if (input.full && input.researchDir && existsSync(input.researchDir)) {
      for (const instance of readdirSync(input.researchDir)) {
        for (const f of readdirSync(join(input.researchDir, instance))) {
          const rel = `research/${instance}/${f}`;
          mkdirSync(join(tmp, "research", instance), { recursive: true });
          writeFileSync(join(tmp, rel), readFileSync(join(input.researchDir, instance, f)));
          researchRel.push(rel);
        }
      }
    }

    const snapshotPath = join(tmp, "ledger.sqlite");
    ledger.db.exec(`vacuum into '${snapshotPath.replace(/'/g, "''")}'`);
    // Held-out results go to promotion code only, never into an export.
    const snapshot = new DatabaseSync(snapshotPath);
    snapshot.exec("drop table if exists held_out; vacuum;");
    snapshot.close();

    const files = [
      "events.jsonl",
      "ledger.sqlite",
      ...attemptIds.flatMap((id) => [`attempts/${id}.patch`, `attempts/${id}.json`]),
      ...championRel,
      ...researchRel,
    ];
    const manifest = {
      unit: input.unit,
      ...(input.full ? { full: true } : {}),
      from_event: since,
      through_event: through,
      created_at: new Date().toISOString(),
      files: Object.fromEntries(
        files.map((f) => [
          f,
          createHash("sha256")
            .update(readFileSync(join(tmp, f)))
            .digest("hex"),
        ]),
      ),
    };
    writeFileSync(join(tmp, "manifest.json"), `${canonicalJson(manifest)}\n`);
    renameSync(tmp, final);
    const id = ledger.recordExport({
      throughEvent: through,
      path: name,
      manifest,
      actor: input.actor,
    });
    // Announced after the export exists: control can then offer it for propagation, and the
    // receiving supervisor finds the patch in the results repository once this export is pushed.
    for (const c of published) {
      const inst = ledger.getInstance(c.instance);
      ledger.appendEvent(input.actor, "champion_published", c.instance, {
        seq: c.seq,
        repo: inst?.seed_repo ?? null,
        base_commit: c.base_commit,
        tree: c.tree,
        sha256: c.sha256,
        path: c.path,
        export: name,
      });
    }
    return { id, dir: final, attempts: attemptIds.length, events: events.length };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
