import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ResearchFolderPaths } from "../agents/research-tools.ts";
import type { Role, Runner } from "../broker/runner.ts";
import type { Ledger } from "../ledger.ts";

/**
 * A research run's folder: everything the run has learned, as files a worker can search with
 * ordinary tools, and a working area for each lane.
 *
 *   INDEX.md, REPORT.md                 the harness writes them
 *   sources/ claims/ findings/          from the harness's records, kept current as they change
 *   hypotheses/ notes/ report/
 *   lanes/LANE/                         each lane's files, as they were when its last trial ended
 *   work/LANE/                          the lane's working area: its own while its trial runs
 *
 * The harness owns all of it but the working areas, so workers read everything and change only
 * their own area; the records stay the source of truth (the files are rebuilt from them). A
 * lane's files are saved in the harness's state when each trial ends (they survive a restart),
 * recorded in the ledger (who wrote what, and when), and shown to the other lanes under lanes/.
 */

type Row = Record<string, unknown>;

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Writes a file whole or not at all: readers never see half of it. */
function writeAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** A file's bytes, never through a symlink. */
function readNoFollow(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Regular files under a directory, relative paths; symlinks and special files are left out. */
function regularFiles(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    const p = rel ? join(dir, rel) : dir;
    const st = lstatSync(p);
    if (st.isDirectory()) {
      for (const n of readdirSync(p).sort()) {
        const r = rel ? join(rel, n) : n;
        if (!skip(r)) visit(r);
      }
    } else if (st.isFile() && rel) out.push(rel);
  };
  if (existsSync(dir)) visit("");
  return out;
}

/** Copies a tree's regular files (modes from the umask: readable by every role). */
function copyTree(from: string, to: string): Map<string, { sha256: string; bytes: number }> {
  const seen = new Map<string, { sha256: string; bytes: number }>();
  mkdirSync(to, { recursive: true });
  for (const rel of regularFiles(from)) {
    let data: Buffer;
    try {
      data = readNoFollow(join(from, rel));
    } catch {
      continue; // changed under us into something else: left out
    }
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    writeFileSync(join(to, rel), data);
    seen.set(rel, { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
  }
  return seen;
}

/** A name safe as one path part: a section's name, say. */
const fileName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "x";

const list = (json: unknown) => JSON.parse(String(json ?? "[]")) as string[];

export class ResearchFolder {
  private readonly ledger: Ledger;
  /** Under scratch: what workers see. */
  private readonly scratchRoot: string;
  /** Under the harness's state: each lane's saved files, which outlive scratch. */
  private readonly stateRoot: string;
  private readonly runner: Runner;
  /** Files already written for records that never change, per run. */
  private readonly written = new Map<string, Set<string>>();
  /** Contents last written for files that do change. */
  private readonly last = new Map<string, string>();

  constructor(o: { ledger: Ledger; scratchRoot: string; stateRoot: string; runner: Runner }) {
    this.ledger = o.ledger;
    this.scratchRoot = o.scratchRoot;
    this.stateRoot = o.stateRoot;
    this.runner = o.runner;
  }

  root(run: string): string {
    if (!SAFE.test(run)) throw new Error(`not a run id for a folder: ${run}`);
    return join(this.scratchRoot, run);
  }

  private all(sql: string, ...p: string[]): Row[] {
    return this.ledger.db.prepare(sql).all(...p) as Row[];
  }

  private once(run: string, path: string, make: () => string | Buffer): void {
    const done = this.written.get(run) ?? new Set<string>();
    this.written.set(run, done);
    if (done.has(path)) return;
    if (!existsSync(path)) writeAtomic(path, make());
    done.add(path);
  }

  private changed(path: string, body: string): void {
    if (this.last.get(path) === body && existsSync(path)) return;
    writeAtomic(path, body);
    this.last.set(path, body);
  }

  /** Brings the folder's harness-written part up to date with the records. */
  sync(run: string): string {
    const root = this.root(run);
    const inst = this.ledger.getRun(run);
    if (inst?.mode !== "research") throw new Error(`${run} is not a research run`);
    const contract = this.ledger.getContract(inst.campaign, inst.version) as {
      title?: string;
      topic?: string;
      questions?: string[];
      quality?: { min_independent_sources?: number };
    };
    for (const d of [
      "sources",
      "claims",
      "findings",
      "hypotheses",
      "notes",
      "report",
      "lanes",
      "work",
    ])
      mkdirSync(join(root, d), { recursive: true });

    const sources = this.all("select * from source where run = ? order by fetched_at", run);
    const urlOf = new Map(sources.map((s) => [String(s.id), String(s.url)]));
    for (const s of sources)
      this.once(run, join(root, "sources", `${s.id}.txt`), () => {
        let text = "";
        try {
          text = readFileSync(String(s.text_path), "utf8");
        } catch {
          text = "(the archived text is missing)";
        }
        return [
          `Source: ${s.id}`,
          `URL: ${s.url}`,
          ...(s.final_url && s.final_url !== s.url ? [`Final URL: ${s.final_url}`] : []),
          ...(s.title ? [`Title: ${s.title}`] : []),
          `Fetched: ${s.fetched_at} by ${s.fetched_by}`,
          "",
          "----- archived text (claims quote these words) -----",
          text,
        ].join("\n");
      });

    const questions = contract.questions ?? [];
    const claims = this.all("select * from claim where run = ? order by created_at", run);
    for (const c of claims)
      this.once(run, join(root, "claims", `${c.id}.md`), () => {
        const quotes = JSON.parse(String(c.quotes)) as { source: string; quote: string }[];
        const problems = list(c.problems);
        const q = c.question === null ? undefined : Number(c.question);
        return [
          `# Claim ${c.id}: ${Number(c.verified) === 1 ? "verified" : "draft"}`,
          "",
          String(c.text),
          "",
          ...(q !== undefined ? [`Question ${q}: ${questions[q] ?? "(no such question)"}`] : []),
          ...(c.confidence !== null ? [`Confidence: ${c.confidence}`] : []),
          `Recorded: ${c.created_at} by ${c.lane ?? "research"}`,
          "",
          "## Quotes",
          "",
          ...quotes.flatMap((x) => [
            `- ${x.source} (${urlOf.get(x.source) ?? "no such source"}):`,
            `  "${x.quote}"`,
          ]),
          ...(problems.length
            ? ["", "## Why it is a draft", "", ...problems.map((p) => `- ${p}`)]
            : []),
          "",
        ].join("\n");
      });

    const findings = this.all("select * from finding where run = ? order by created_at", run);
    for (const f of findings)
      this.once(run, join(root, "findings", `${f.id}.md`), () =>
        [
          `# Finding ${f.id}: ${Number(f.supported) === 1 ? "supported" : "draft"}`,
          "",
          String(f.text),
          "",
          "## Summary",
          "",
          String(f.summary),
          "",
          "## Why it matters",
          "",
          String(f.why_it_matters),
          "",
          "## Supporting claims",
          "",
          ...list(f.supporting).map((id) => `- ${id} (claims/${id}.md)`),
          ...(list(f.problems).length
            ? ["", "## Why it is a draft", "", ...list(f.problems).map((p) => `- ${p}`)]
            : []),
          "",
          `Recorded: ${f.created_at} by ${f.lane ?? "research"}`,
          "",
        ].join("\n"),
      );

    const hypotheses = this.all("select * from hypothesis where run = ? order by created_at", run);
    for (const h of hypotheses)
      this.once(run, join(root, "hypotheses", `${h.id}.md`), () =>
        [
          `# Hypothesis ${h.id}`,
          "",
          String(h.text),
          "",
          `Supporting verified claims: ${list(h.supporting).join(", ") || "none"}`,
          `Recorded: ${h.created_at} by ${h.lane ?? "research"}`,
          "",
        ].join("\n"),
      );

    const notes = this.all("select * from note where run = ? order by id", run);
    for (const n of notes)
      this.once(run, join(root, "notes", `note-${String(n.id).padStart(5, "0")}.md`), () =>
        [
          `# Note ${n.id}`,
          "",
          String(n.text),
          "",
          `Sources: ${list(n.sources).join(", ") || "none"}`,
          `Recorded: ${n.created_at} by ${n.lane ?? "research"}`,
          "",
        ].join("\n"),
      );

    const sections = this.all("select * from report_section where run = ? order by name", run);
    for (const s of sections)
      this.changed(
        join(root, "report", `${fileName(String(s.name))}.md`),
        `# ${s.name}\n\n${s.body}\n\nUpdated: ${s.updated_at} by ${s.updated_by}\n`,
      );

    const report = this.all(
      "select kind, body, created_at from report_version where run = ? order by id desc limit 1",
      run,
    )[0];
    this.changed(
      join(root, "REPORT.md"),
      report
        ? `<!-- the ${report.kind} report of ${report.created_at}, written by the harness -->\n\n${report.body}\n`
        : "No report yet: the harness writes one at each digest and at the end.\n",
    );

    // The newest state of each file each lane wrote.
    const files = this.all(
      `select f.lane, f.path, f.bytes, f.recorded_at from research_file f
        where f.run = ? and f.change = 'written' and f.id = (
          select max(g.id) from research_file g where g.run = f.run and g.lane = f.lane and g.path = f.path)
        order by f.lane, f.path`,
      run,
    );
    const verified = claims.filter((c) => Number(c.verified) === 1).length;
    this.changed(
      join(root, "INDEX.md"),
      [
        `# ${contract.title ?? run}`,
        "",
        ...(contract.topic ? [`Topic: ${contract.topic}`, ""] : []),
        "This folder holds what this research campaign has learned so far. The harness writes it from its records and keeps it current. Every worker can read all of it; each lane writes only in its own working area, work/LANE/.",
        "",
        "## Questions",
        "",
        ...questions.map(
          (q, i) =>
            `${i}. ${q} (${claims.filter((c) => Number(c.verified) === 1 && Number(c.question) === i).length} verified claims)`,
        ),
        "",
        "## What is here",
        "",
        "- REPORT.md: the newest report (a digest, or the final report)",
        `- sources/: ${sources.length} archived pages as text, one file each (claims quote these words)`,
        `- claims/: ${claims.length} claims, ${verified} verified and ${claims.length - verified} drafts (the first line says which)`,
        `- findings/: ${findings.length} findings (${findings.filter((f) => Number(f.supported) === 1).length} supported)`,
        `- hypotheses/: ${hypotheses.length}`,
        `- notes/: ${notes.length}`,
        `- report/: ${sections.length} report sections`,
        `- lanes/: the files each lane wrote, as they were when its last trial ended (${files.length} files)`,
        "",
        "## Findings",
        "",
        ...(findings.length
          ? findings.map(
              (f) =>
                `- ${f.id} (${Number(f.supported) === 1 ? "supported" : "draft"}): ${String(f.text).replace(/\s+/g, " ").slice(0, 300)}`,
            )
          : ["None yet."]),
        "",
        "## Hypotheses",
        "",
        ...(hypotheses.length
          ? hypotheses.map((h) => `- ${h.id}: ${String(h.text).replace(/\s+/g, " ").slice(0, 300)}`)
          : ["None yet."]),
        "",
        "## Lanes' files",
        "",
        ...(files.length
          ? files.map((f) => `- lanes/${f.lane}/${f.path} (${f.bytes} bytes, ${f.recorded_at})`)
          : ["None yet."]),
        "",
      ].join("\n"),
    );
    return root;
  }

  private saved(run: string, lane: string): string {
    return join(this.stateRoot, run, lane);
  }

  /**
   * A lane's trial is about to start: the folder brought up to date, and its working area (its
   * saved files back after a restart) handed to the role the trial runs as.
   */
  async prepareLane(run: string, lane: string, role: Role): Promise<ResearchFolderPaths> {
    if (!/^lane-\d+$/.test(lane)) throw new Error(`not a lane: ${lane}`);
    const root = this.sync(run);
    this.showLanes(run);
    const work = join(root, "work", lane);
    if (!existsSync(work)) {
      const saved = this.saved(run, lane);
      if (existsSync(saved)) copyTree(saved, work);
      else mkdirSync(work, { recursive: true });
    }
    await this.runner.handOver(work, role);
    return { root, work };
  }

  /** Each lane's saved files under lanes/, where the scratch copy is missing (after a restart). */
  private showLanes(run: string): void {
    const base = join(this.stateRoot, run);
    if (!existsSync(base)) return;
    for (const lane of readdirSync(base)) {
      if (!/^lane-\d+$/.test(lane)) continue;
      const shown = join(this.root(run), "lanes", lane);
      if (!existsSync(shown)) copyTree(join(base, lane), shown);
    }
  }

  /**
   * A lane's trial has ended (its processes are gone): its working area is taken back, its files
   * saved and recorded (what changed since the last save), and shown to the other lanes.
   */
  async captureLane(
    run: string,
    lane: string,
    trial: string | null,
  ): Promise<{ written: number; removed: number }> {
    if (!/^lane-\d+$/.test(lane)) throw new Error(`not a lane: ${lane}`);
    const root = this.root(run);
    const work = join(root, "work", lane);
    if (!existsSync(work)) return { written: 0, removed: 0 };
    await this.runner.reclaim(work);
    const saved = this.saved(run, lane);
    const manifestPath = `${saved}.json`;
    const before = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
          string,
          { sha256: string; bytes: number }
        >)
      : {};
    const tmp = `${saved}.tmp-${randomUUID().slice(0, 8)}`;
    const now = copyTree(work, tmp);
    const at = new Date().toISOString();
    let written = 0;
    let removed = 0;
    this.ledger.tx(() => {
      const add = this.ledger.db.prepare(
        "insert into research_file (run, lane, trial, path, change, bytes, sha256, recorded_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const [rel, f] of now) {
        if (before[rel]?.sha256 === f.sha256) continue;
        add.run(run, lane, trial, rel, "written", f.bytes, f.sha256, at);
        written++;
      }
      for (const rel of Object.keys(before)) {
        if (now.has(rel)) continue;
        add.run(run, lane, trial, rel, "removed", null, null, at);
        removed++;
      }
      if (written || removed)
        this.ledger.appendEvent(lane, "research_files_saved", run, {
          trial,
          written,
          removed,
          files: now.size,
        });
    });
    rmSync(saved, { recursive: true, force: true });
    renameSync(tmp, saved);
    writeAtomic(manifestPath, JSON.stringify(Object.fromEntries(now)));
    // What the other lanes see.
    const shown = join(root, "lanes", lane);
    const shownTmp = `${shown}.tmp-${randomUUID().slice(0, 8)}`;
    copyTree(saved, shownTmp);
    rmSync(shown, { recursive: true, force: true });
    renameSync(shownTmp, shown);
    this.sync(run);
    return { written, removed };
  }

  /**
   * The folder for an export, without the working areas: rebuilt from the records and the
   * saved files when scratch was cleared. Relative paths of its regular files.
   */
  exportFiles(run: string): { root: string; files: string[] } {
    const root = this.sync(run);
    this.showLanes(run);
    return {
      root,
      files: regularFiles(root, (rel) => rel === "work" || /\.tmp-[0-9a-f]{8}$/.test(rel)),
    };
  }
}
