import { randomUUID } from "node:crypto";
import type { StructuredDirective } from "../../core/commands.ts";
import type { Contract } from "../../core/contract.ts";
import type { Role, Runner } from "../broker/runner.ts";
import type { Ledger } from "../ledger.ts";
import type { HarnessService } from "../service.ts";
import type { ModelConfig } from "./model.ts";
import { lanesOf, type PlannerInput, plan } from "./planner.ts";
import { type Assignment, Registry } from "./registry.ts";
import type { TrialResult, TrialSpec } from "./worker.ts";
import { prepareWorkspace } from "./workspace.ts";

/**
 * The agent scheduler (SLA pattern). Each epoch the planner assigns every lane a direction; each
 * lane then runs `trials_per_epoch` trials, one at a time: a fresh workspace at the champion (or
 * the lane's best), one worker invocation, at most one submission, and the next trial only after
 * that submission is judged. An epoch ends when its lanes' trials are judged (or at a time cap).
 * Agents never judge: the scheduler only reads verdicts.
 */

const SETTLED = new Set([
  "judged",
  "promoted",
  "rejected_v0",
  "duplicate",
  "errored",
  "awaiting_approval",
  "awaiting_audit",
]);
const KEEP = new Set(["win_screened", "win_confirmed"]);

export interface SchedulerOptions {
  service: HarnessService;
  runner: Runner;
  model?: ModelConfig | undefined;
  /** Runs one trial (in a child process in the harness; in-process in tests). */
  runTrial: (spec: TrialSpec) => Promise<TrialResult>;
  owner: string;
  maxConcurrent?: number | undefined;
  trialWallMs?: number | undefined;
  maxTurns?: number | undefined;
  epochCapMs?: number | undefined;
}

export class Scheduler {
  readonly registry: Registry;
  private readonly o: Required<Omit<SchedulerOptions, "model">> & {
    model?: ModelConfig | undefined;
  };
  private readonly ledger: Ledger;
  private readonly running = new Map<string, Promise<void>>();

  constructor(opts: SchedulerOptions) {
    this.o = {
      maxConcurrent: 1,
      trialWallMs: 20 * 60_000,
      maxTurns: 60,
      epochCapMs: 3 * 3_600_000,
      ...opts,
    } as typeof this.o;
    this.ledger = opts.service.ledger;
    this.registry = new Registry(this.ledger);
  }

  /** Trials still running (awaited by tests and on shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private instance(): { id: string; contract: Contract } | undefined {
    const inst = this.ledger.listInstances().find((i) => i.status === "running");
    if (!inst || (inst.mode !== "hill_climb" && inst.mode !== "goal")) return undefined;
    return { id: inst.id, contract: this.o.service.contractFor(inst.id) };
  }

  private settled(attempt: string | null): boolean {
    if (!attempt) return true;
    return SETTLED.has(String(this.ledger.getAttempt(attempt)?.lifecycle));
  }

  private directives(instance: string): { id: number; body: StructuredDirective }[] {
    return this.ledger.activeDirectives(instance).map((d) => ({
      id: d.id,
      body: d.body as StructuredDirective,
    }));
  }

  private laneCount(instance: string, contract: Contract): number {
    const cap = contract.lanes.count;
    const d = this.directives(instance)
      .filter((x) => x.body.kind === "lane_count" && typeof x.body.value === "number")
      .at(-1);
    return Math.max(1, Math.min(cap, Number(d?.body.value ?? cap)));
  }

  /** Relative gain of the current champion over the seed, from the confirmed steps. */
  private championGain(instance: string): number {
    let gain = 1;
    const rows = this.ledger.db
      .prepare(
        "select attempt from champion where instance = ? and reopened = 0 and attempt is not null",
      )
      .all(instance) as { attempt: string }[];
    for (const r of rows) {
      const v = this.ledger.db
        .prepare(
          "select delta from verdict where attempt = ? and verdict = 'win_confirmed' order by id desc limit 1",
        )
        .get(r.attempt) as { delta: number | null } | undefined;
      gain *= 1 + (v?.delta ?? 0);
    }
    return gain - 1;
  }

  /** Keeps each lane's best: a judged win of the lane that beats its previous best (SLA keep rule). */
  private updateLaneBests(instance: string, lanes: string[]): void {
    for (const lane of lanes) {
      const best = this.registry.laneBest(instance, lane);
      const bestDelta = best
        ? (this.registry.evidence(instance, 500, lane).find((e) => e.attempt === best)?.delta ??
          null)
        : null;
      for (const e of this.registry.evidence(instance, 20, lane)) {
        if (!e.verdict || !KEEP.has(e.verdict) || e.delta === null || e.attempt === best) continue;
        if (bestDelta === null || e.delta > bestDelta) {
          this.registry.setLaneBest(instance, lane, e.attempt, this.o.owner);
          break;
        }
      }
    }
  }

  private async planEpoch(instance: string, contract: Contract, n: number): Promise<void> {
    const laneCount = this.laneCount(instance, contract);
    const lanes = lanesOf(laneCount);
    const champion = this.ledger.currentChampion(instance);
    const input: PlannerInput = {
      instance,
      epoch: n,
      laneCount,
      objective: objectiveOf(contract),
      editablePaths: "editable_paths" in contract ? contract.editable_paths : [],
      champion: { seq: champion.seq, gain: this.championGain(instance) },
      families: this.registry.families(instance),
      evidence: this.registry.evidence(instance, 30),
      directives: this.directives(instance),
      laneBests: Object.fromEntries(lanes.map((l) => [l, this.registry.laneBest(instance, l)])),
    };
    const p = await plan(input, this.o.model);
    for (const f of p.newFamilies)
      this.registry.addFamily(instance, f.id, f.description, `planner:${p.source}`);
    this.registry.startEpoch({
      instance,
      n,
      source: p.source,
      tries: p.tries,
      valid: p.valid,
      rawViolations: p.rawViolations,
      assignments: p.assignments,
      notes: p.notes,
      by: this.o.owner,
    });
  }

  /** One scheduling step: plan when needed, start trials that may start. */
  async tick(): Promise<boolean> {
    const inst = this.instance();
    if (!inst || !this.o.model) return false;
    const { id, contract } = inst;
    const perEpoch = contract.lanes.trials_per_epoch;
    let epoch = this.registry.currentEpoch(id);
    if (!epoch || epoch.ended_at) {
      await this.planEpoch(id, contract, (epoch?.n ?? 0) + 1);
      epoch = this.registry.currentEpoch(id);
      if (!epoch) return false;
    }
    this.updateLaneBests(
      id,
      epoch.assignments.map((a) => a.lane),
    );

    let started = false;
    let complete = true;
    for (const a of epoch.assignments) {
      const trials = this.registry.trials(id, a.lane, epoch.n);
      const last = trials.at(-1);
      const laneDone =
        trials.length >= perEpoch &&
        trials.every((t) => t.ended) &&
        this.settled(last?.attempt ?? null);
      if (!laneDone) complete = false;
      if (trials.length >= perEpoch || this.running.has(a.lane)) continue;
      if (last && (!last.ended || !this.settled(last.attempt))) continue;
      if (this.running.size >= this.o.maxConcurrent) continue;
      this.startTrial(id, contract, epoch.n, a, trials.length + 1, perEpoch);
      started = true;
    }
    const capped = Date.now() - Date.parse(epoch.started_at) > this.o.epochCapMs;
    if ((complete || capped) && !this.running.size)
      this.registry.endEpoch(id, epoch.n, this.o.owner);
    return started;
  }

  private startTrial(
    instance: string,
    contract: Contract,
    epoch: number,
    a: Assignment,
    k: number,
    perEpoch: number,
  ): void {
    const lane = a.lane as Role;
    const id = `t-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const work = (async () => {
      const inst = this.ledger.getInstance(instance);
      if (!inst) return;
      const champion = this.ledger.currentChampion(instance);
      const best = this.registry.laneBest(instance, a.lane);
      const parent =
        a.parent === "lane_best" && best
          ? String(this.ledger.getAttempt(best)?.commit_sha)
          : champion.commit_sha;
      this.registry.startTrial({ id, instance, lane: a.lane, epoch, family: a.family, parent });
      let ws: { dir: string; repo: string } | undefined;
      let r: TrialResult = { stopped: "error", turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      try {
        ws = await prepareWorkspace({
          runner: this.o.runner,
          scratchDir: this.o.service.paths.scratchDir,
          mirror: this.o.service.mirrorFor(inst.seed_repo),
          commit: parent,
          lane,
        });
        r = await this.o.runTrial({
          trialId: id,
          instance,
          lane,
          workspace: ws.repo,
          parentCommit: parent,
          brief: this.brief(
            instance,
            contract,
            epoch,
            a,
            k,
            perEpoch,
            parent === champion.commit_sha
              ? `the champion (seq ${champion.seq})`
              : `your lane's best attempt ${best}`,
          ),
          wallMs: this.o.trialWallMs,
          maxTurns: this.o.maxTurns,
        });
      } catch (err) {
        r = { ...r, stopped: "error", error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (r.submitted) this.registry.tagAttempt(r.submitted.attempt, a.family);
        this.registry.finishTrial(id, { ...r, attempt: r.submitted?.attempt }, this.o.owner);
        await this.o.runner.killRole(lane).catch(() => 0);
        if (ws) await this.o.runner.remove(ws.dir).catch(() => undefined);
      }
    })().finally(() => this.running.delete(a.lane));
    this.running.set(a.lane, work);
  }

  /** The worker's brief: built only from the ledger, and only from this lane's own history. */
  private brief(
    instance: string,
    contract: Contract,
    epoch: number,
    a: Assignment,
    k: number,
    perEpoch: number,
    start: string,
  ): string {
    const fam = this.registry.families(instance).find((f) => f.id === a.family);
    const mine = this.registry.evidence(instance, 3, a.lane);
    const feedback = mine.length
      ? mine
          .map((e) => {
            const v = e.verdict ? this.ledger.currentVerdict(e.attempt) : undefined;
            const reasons = v
              ? String(
                  (
                    this.ledger.db.prepare("select reasons from verdict where id = ?").get(v.id) as
                      | { reasons: string }
                      | undefined
                  )?.reasons ?? "",
                ).slice(0, 600)
              : "";
            const v0 = this.ledger.getAttempt(e.attempt)?.v0;
            const violations = v0
              ? (JSON.parse(String(v0)) as { violations: string[] }).violations
              : [];
            return `- ${e.attempt} (${e.hypothesis ?? "no hypothesis"}): ${e.verdict ?? e.lifecycle}${
              e.delta !== null ? `, change ${(e.delta * 100).toFixed(2)}%` : ""
            }${reasons ? `. Judge: ${reasons}` : ""}${violations.length ? `. Refused before building: ${violations.join("; ")}` : ""}`;
          })
          .join("\n")
      : "- none yet";
    return [
      `# Assignment (epoch ${epoch}, trial ${k} of ${perEpoch}, ${a.lane})`,
      `Campaign: ${contract.title} (${contract.mode})`,
      `Objective: ${objectiveOf(contract)}`,
      `Editable paths: ${"editable_paths" in contract ? contract.editable_paths.join(", ") : "none"}`,
      "forbidden_patterns" in contract && contract.forbidden_patterns.length
        ? `Changes may not add lines matching: ${contract.forbidden_patterns.join(", ")}`
        : "",
      `Starting point: ${start}.`,
      `Direction: ${a.family}${fam ? ` (${fam.description})` : ""}`,
      `Focus: ${a.focus}`,
      "",
      "# Your lane's recent attempts and the judge's findings",
      feedback,
      "",
      "# How to work",
      "Read the relevant code, make one focused change in the editable paths, build and test it with run, then call submit once. The judge measures it on the real target; your own timings never count.",
    ]
      .filter((l) => l !== "")
      .join("\n");
  }
}

function objectiveOf(c: Contract): string {
  if (c.mode === "hill_climb") {
    const p = c.objective.primary;
    return `${p.direction === "max" ? "increase" : "decrease"} ${p.metric} (at least ${(p.min_effect * 100).toFixed(1)}% to count) on cells ${c.cells.join(", ")}, without breaking correctness`;
  }
  if (c.mode === "goal") {
    return `reach these goals: ${c.goals.map((g) => `${g.id} (${g.description})`).join("; ")}`;
  }
  return c.topic;
}
