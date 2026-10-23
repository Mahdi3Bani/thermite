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
import { knowledgePart } from "./kb-part.ts";
import type { Ledger } from "./ledger.ts";
import { championFiles } from "./propagation.ts";

/**
 * Outbox export. The harness has no git credentials and no remote access: it writes exports
 * into the shared outbox, and the supervisor pushes them to the results repository as packed
 * commits. An export holds patches and manifests for attempts recorded since the last export,
 * the events since then, the runs' field notes, research notes and briefings since then, the
 * runs' part of their campaigns' folders in the knowledge base that changed since then, a
 * consistent ledger snapshot, each new run champion as a patch against its seed (what other rigs
 * need to judge it themselves), and the research folder of each run that finished. A full export
 * also holds the research archive and the research folder of every run, finished or not.
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
  rig: string;
  actor: string;
  /**
   * A full export (a full reset's, or the owner's choice): also the research archive and every
   * run's research folder, finished or not, marked in the manifest.
   */
  full?: boolean | undefined;
  researchDir?: string | undefined;
  /**
   * A research run's folder (research/folder.ts): exported with the run's final report, and in
   * every full export.
   */
  researchFolder?: ((run: string) => { root: string; files: string[] }) | undefined;
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
      const run = ledger.getRun(String(a.run));
      const mirror = input.mirrorFor(run?.seed_repo ?? "");
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
      for (const run of readdirSync(input.researchDir)) {
        for (const f of readdirSync(join(input.researchDir, run))) {
          const rel = `research/${run}/${f}`;
          mkdirSync(join(tmp, "research", run), { recursive: true });
          writeFileSync(join(tmp, rel), readFileSync(join(input.researchDir, run, f)));
          researchRel.push(rel);
        }
      }
    }

    // A run's field notes recorded since the last export (journal.jsonl), the research notes
    // (research-notes.jsonl, with every source they cite) and the background the owner picked
    // for runs created since then (briefing.jsonl), oldest first. The ledger snapshot holds all of
    // them too; these are for readers without SQLite.
    const ids = (kind: string, field: string) =>
      events
        .filter((e) => e.kind === kind)
        .map((e) => Number((e.body as Record<string, unknown>)[field]))
        .filter((n) => Number.isInteger(n));
    const rowsOf = (table: string, list: number[]) =>
      list.length
        ? (ledger.db
            .prepare(
              `select * from ${table} where id in (${list.map(() => "?").join(", ")}) order by id`,
            )
            .all(...list) as Record<string, unknown>[])
        : [];
    const jsonl = (rows: unknown[]) =>
      rows.map((r) => canonicalJson(r)).join("\n") + (rows.length ? "\n" : "");
    const journal = rowsOf("journal_note", ids("journal_note", "id")).map((r) => ({
      id: Number(r.id),
      run: String(r.run),
      by: String(r.by),
      kind: String(r.kind),
      text: String(r.text),
      about: { type: String(r.about_type), id: String(r.about_id) },
      ...(r.lane ? { lane: String(r.lane) } : {}),
      ...(r.trial ? { trial: String(r.trial) } : {}),
      at: String(r.at),
    }));
    writeFileSync(join(tmp, "journal.jsonl"), jsonl(journal));
    const notesRel: string[] = [];
    const researchNotes = rowsOf("note", ids("research_note", "note")).map((r) => ({
      id: Number(r.id),
      run: String(r.run),
      lane: r.lane === null ? null : String(r.lane),
      text: String(r.text),
      sources: JSON.parse(String(r.sources)) as string[],
      at: String(r.created_at),
    }));
    if (researchNotes.length) {
      writeFileSync(join(tmp, "research-notes.jsonl"), jsonl(researchNotes));
      notesRel.push("research-notes.jsonl");
    }
    const created = [
      ...new Set(events.filter((e) => e.kind === "run_created").map((e) => String(e.subject))),
    ];
    const briefing = created.flatMap((run) =>
      ledger.briefing(run).map((b, i) => ({ run, seq: i + 1, ...b })),
    );
    if (briefing.length) {
      writeFileSync(join(tmp, "briefing.jsonl"), jsonl(briefing));
      notesRel.push("briefing.jsonl");
    }
    // The runs' part of their campaigns' folders (knowledge.jsonl): each item that an event
    // since the last export added or changed, as it stands now, with its origin, read as
    // control reads it into the knowledge base.
    const part = knowledgePart(ledger, input.rig, since, through);
    if (part.length) {
      writeFileSync(join(tmp, "knowledge.jsonl"), jsonl(part));
      notesRel.push("knowledge.jsonl");
    }

    // A research campaign's output is its report and its whole folder: claims, findings, notes,
    // sources, the lanes' files and the conversations kept before compactions, exported once its
    // final report is written. A hill-climb or goal run that recorded sources, claims or notes,
    // or compacted a conversation, exports its folder when it is closed.
    if (input.researchFolder) {
      const recorded = (run: string) =>
        Number(
          (
            ledger.db
              .prepare(
                `select (select count(*) from source where run = ?) + (select count(*) from claim where run = ?)
                   + (select count(*) from note where run = ?)
                   + (select count(*) from event where kind = 'context_compacted' and subject = ?) as n`,
              )
              .get(run, run, run, run) as { n: number }
          ).n,
        ) > 0;
      const finished = new Set([
        ...events.filter((e) => e.kind === "research_final").map((e) => String(e.subject)),
        ...events
          .filter(
            (e) =>
              e.kind === "run_status" &&
              (e.body as { status?: string }).status === "closed" &&
              ledger.getRun(String(e.subject))?.mode !== "research" &&
              recorded(String(e.subject)),
          )
          .map((e) => String(e.subject)),
      ]);
      // Where each run's folder goes in the export: a run that finished, at research/<run>/folder/.
      const at = new Map([...finished].map((run) => [run, `research/${run}/folder`]));
      // A full export also takes the folder of every other run that has one (goal 103): a
      // research run's, and a hill-climb or goal run's that recorded research, so a run's whole
      // record can leave the rig even while it runs, is paused or is broken. It goes beside the
      // final one, under the export's name: a results repository never replaces a file it has,
      // so the folder the run's end exports must not be taken already.
      if (input.full)
        for (const r of ledger.listRuns())
          if (!at.has(r.id) && (r.mode === "research" || recorded(r.id)))
            at.set(r.id, `research/${r.id}/folder-${name}`);
      for (const [run, place] of at) {
        let folder: { root: string; files: string[] };
        try {
          folder = input.researchFolder(run);
        } catch {
          continue;
        }
        for (const f of folder.files) {
          const rel = `${place}/${f}`;
          mkdirSync(dirname(join(tmp, rel)), { recursive: true });
          writeFileSync(join(tmp, rel), readFileSync(join(folder.root, f)));
          researchRel.push(rel);
        }
      }
    }

    const snapshotPath = join(tmp, "ledger.sqlite");
    ledger.db.exec(`vacuum into '${snapshotPath.replace(/'/g, "''")}'`);
    // The held_out table, the judge's whole record of each held-out check, never goes into an
    // export. The owner's record of one does (goal 082): the held_out_checked event, with each
    // held-out cell's name, kind of failure and value against its threshold (at most 50 cells),
    // is in the events table and events.jsonl, as it reaches control. No agent reads events.
    const snapshot = new DatabaseSync(snapshotPath);
    snapshot.exec("drop table if exists held_out; vacuum;");
    snapshot.close();

    const files = [
      "events.jsonl",
      "journal.jsonl",
      ...notesRel,
      "ledger.sqlite",
      ...attemptIds.flatMap((id) => [`attempts/${id}.patch`, `attempts/${id}.json`]),
      ...championRel,
      ...researchRel,
    ];
    const manifest = {
      rig: input.rig,
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
      const inst = ledger.getRun(c.run);
      ledger.appendEvent(input.actor, "champion_published", c.run, {
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
