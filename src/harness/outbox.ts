import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../core/canonical.ts";
import { patchBetween } from "./git.ts";
import type { Ledger } from "./ledger.ts";

/**
 * Outbox export. The harness has no git credentials and no remote access: it writes exports
 * into the shared outbox, and the supervisor pushes them to the results repository as packed
 * commits. An export holds patches and manifests for attempts recorded since the last export,
 * the events since then, and a consistent ledger snapshot.
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
      const patch = await patchBetween(mirror, String(a.parent_commit), String(a.commit_sha));
      writeFileSync(join(tmp, "attempts", `${id}.patch`), patch);
      writeFileSync(
        join(tmp, "attempts", `${id}.json`),
        `${canonicalJson({ attempt: a, verdict: ledger.currentVerdict(id) ?? null })}\n`,
      );
    }

    ledger.db.exec(`vacuum into '${join(tmp, "ledger.sqlite").replace(/'/g, "''")}'`);

    const files = [
      "events.jsonl",
      "ledger.sqlite",
      ...attemptIds.flatMap((id) => [`attempts/${id}.patch`, `attempts/${id}.json`]),
    ];
    const manifest = {
      unit: input.unit,
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
    return { id, dir: final, attempts: attemptIds.length, events: events.length };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
