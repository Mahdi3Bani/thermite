import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ExperimentText, type QueuePosition } from "../core/commands.ts";
import { type ExperimentRow, type Ledger, LedgerError } from "./ledger.ts";

/**
 * Each run's experiment queue (goal 064): the experiments still to try, in order, and the log
 * of those tried, with what became of each. It is research state, so it lives in the ledger.
 *
 * States: `proposed` (a lane's idea, waiting for the planner or the owner), `queued` (up next,
 * in order), `assigned` (a lane's trial works on it), `done` (its trial ended: its attempt, or
 * no attempt and why) and `dropped` (with who dropped it and why).
 *
 * Writers: the owner (signed commands), the planner (it coordinates: it gives queued work to
 * lanes without overlap, and adds, moves, drops and accepts experiments), the advisors (add and
 * move) and the workers (propose ideas). Every change is one call of the ledger's
 * writeExperiments: its rows and one event, in one transaction. Control builds its view of the
 * queue from those events, so the places here follow control's rule exactly: an experiment's
 * place is its index among the queued ones (0 first), and a position names an index among the
 * others ("top": 0, "end": after the last).
 */

export type Experiment = ExperimentRow;
export type ExperimentState = ExperimentRow["state"];

/** An experiment's text, as every writer gives it (the same limits as the owner's commands). */
export const ExperimentInput = z.object({
  title: ExperimentText.title,
  details: ExperimentText.details.optional(),
  family: ExperimentText.family.optional(),
  why: ExperimentText.why.optional(),
});
export type ExperimentInput = z.infer<typeof ExperimentInput>;

/** A new experiment's id: `x-` and 12 hex characters. */
export function newExperimentId(): string {
  return `x-${randomBytes(6).toString("hex")}`;
}

/**
 * The direction-registry family an experiment's direction stands for: its family when that is
 * already a family's id, else its words made into one ("Loop order" is loop-order). None for an
 * experiment with no direction, or words that make no id.
 */
export function directionOf(family: string): string | undefined {
  const id = family
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 41)
    .replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(id) ? id : undefined;
}

/** Whether an experiment's direction is the family a rule names (exactly, or as its id). */
export function inFamily(x: Pick<Experiment, "family">, family: string): boolean {
  return x.family !== "" && (x.family === family || directionOf(x.family) === family);
}

/** Where a position puts an experiment among `others` queued ones: an index, as control does. */
function indexOf(pos: QueuePosition | undefined, others: number): number {
  if (pos === "top") return 0;
  if (typeof pos === "number") return Math.max(0, Math.min(others, Math.trunc(pos)));
  return others;
}

/** An experiment as an agent reads it in the queue's brief. */
export interface BriefExperiment {
  id: string;
  title: string;
  details?: string;
  family?: string;
  why?: string;
  by: string;
}

export interface QueueBrief {
  up_next: BriefExperiment[];
  proposed: BriefExperiment[];
  in_progress: (BriefExperiment & { lane: string })[];
  tried: (BriefExperiment & {
    lane?: string;
    result: string;
    attempt?: string;
    verdict?: string;
    delta?: number;
    lifecycle?: string;
  })[];
}

type Row = Omit<ExperimentRow, "created_at" | "updated_at">;
const strip = ({ created_at: _c, updated_at: _u, ...r }: ExperimentRow): Row => r;

export class ExperimentQueue {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  // ------------------------------------------------------------------ reads

  get(id: string): Experiment | undefined {
    return this.ledger.getExperiment(id);
  }

  /** Every experiment of the run, oldest first. */
  all(run: string): Experiment[] {
    return this.ledger.experiments(run);
  }

  /** Up next, in order. */
  queued(run: string): Experiment[] {
    return this.all(run)
      .filter((x) => x.state === "queued")
      .sort((a, b) => (a.place ?? 0) - (b.place ?? 0));
  }

  /** The lanes' ideas waiting for the planner or the owner, oldest first. */
  proposed(run: string): Experiment[] {
    return this.all(run).filter((x) => x.state === "proposed");
  }

  /** Experiments a lane's trial works on now. */
  assigned(run: string): Experiment[] {
    return this.all(run).filter((x) => x.state === "assigned");
  }

  /** Experiments that ended (done or dropped), newest first. */
  tried(run: string, limit = 20): Experiment[] {
    return this.all(run)
      .filter((x) => x.state === "done" || x.state === "dropped")
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, limit);
  }

  /** The experiment a trial works (or worked) on, if it had one. */
  forTrial(trial: string): Experiment | undefined {
    const id = (
      this.ledger.db
        .prepare("select id from experiment where trial = ? order by updated_at desc limit 1")
        .get(trial) as { id: string } | undefined
    )?.id;
    return id ? this.get(id) : undefined;
  }

  /**
   * The queue as an agent reads it (the planner, the teacher pair): up next in order, the
   * lanes' ideas, what each lane is on, and the newest tried with their results (the judge's
   * verdict and change for an attempt). Long texts are shortened.
   */
  brief(run: string, o: { upNext?: number; proposed?: number; tried?: number } = {}): QueueBrief {
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    const text = (x: Experiment) => ({
      id: x.id,
      title: x.title,
      ...(x.details ? { details: clip(x.details, 600) } : {}),
      ...(x.family ? { family: x.family } : {}),
      ...(x.why ? { why: clip(x.why, 400) } : {}),
      by: x.added_by,
    });
    const judged = (attempt: string) => {
      const v = this.ledger.currentVerdict(attempt);
      if (!v) return { lifecycle: String(this.ledger.getAttempt(attempt)?.lifecycle ?? "") };
      const d = this.ledger.db.prepare("select delta from verdict where id = ?").get(v.id) as
        | { delta: number | null }
        | undefined;
      return { verdict: v.verdict, ...(typeof d?.delta === "number" ? { delta: d.delta } : {}) };
    };
    return {
      up_next: this.queued(run)
        .slice(0, o.upNext ?? 40)
        .map(text),
      proposed: this.proposed(run)
        .slice(-(o.proposed ?? 20))
        .map(text),
      in_progress: this.assigned(run).map((x) => ({ ...text(x), lane: x.lane ?? "" })),
      tried: this.tried(run, o.tried ?? 20).map((x) => ({
        ...text(x),
        ...(x.lane ? { lane: x.lane } : {}),
        result:
          x.state === "dropped"
            ? `dropped by ${x.dropped_by ?? "?"}: ${clip(x.dropped_why ?? "", 300)}`
            : (x.result ?? ""),
        ...(x.attempt ? { attempt: x.attempt, ...judged(x.attempt) } : {}),
      })),
    };
  }

  /** An experiment of this run, or a refusal in words. */
  require(run: string, id: string): Experiment {
    const x = this.get(id);
    if (!x || x.run !== run)
      throw new LedgerError("not_found", `no experiment ${id} in run ${run}`);
    return x;
  }

  // ------------------------------------------------------------------ writes

  /**
   * The rows for a new order of the queued experiments: `x` placed at `pos` among the others
   * (or taken out, with `pos` undefined and `leave`), and every other queued one whose place
   * changed.
   */
  private reorder(run: string, x: Row, how: { place: QueuePosition | undefined } | "leave"): Row[] {
    const others = this.queued(run).filter((q) => q.id !== x.id);
    const order: Row[] = others.map(strip);
    if (how !== "leave") order.splice(indexOf(how.place, others.length), 0, x);
    const rows: Row[] = [];
    order.forEach((r, i) => {
      if (r === x) {
        x.place = i;
        return;
      }
      if (r.place !== i) rows.push({ ...r, place: i });
    });
    if (how === "leave") x.place = null;
    return [x, ...rows];
  }

  /** The owner's, the planner's, an advisor's or a lane's new experiment. */
  add(
    run: string,
    input: ExperimentInput & {
      by: string;
      state?: "queued" | "proposed" | undefined;
      position?: QueuePosition | undefined;
      from?: { run: string; id: string } | undefined;
      /** A lane's idea: the trial it came from (in the event, for the record). */
      trial?: string | undefined;
      /**
       * Back in the queue because its trial was interrupted or failed: the experiment it repeats
       * and that trial (in the event as `requeued_from`, so History says why it came back).
       */
      requeued?:
        | {
            experiment: string;
            trial: string;
            lane: string | null;
            result: "interrupted" | "error";
          }
        | undefined;
    },
    actor: string,
  ): Experiment {
    const text = ExperimentInput.parse(input);
    const state = input.state ?? "queued";
    const x: Row = {
      id: newExperimentId(),
      run,
      title: text.title,
      details: text.details ?? "",
      family: text.family ?? "",
      why: text.why ?? "",
      added_by: input.by,
      state,
      place: null,
      lane: null,
      trial: null,
      attempt: null,
      result: null,
      dropped_by: null,
      dropped_why: null,
      from_run: input.from?.run ?? null,
      from_id: input.from?.id ?? null,
    };
    const rows = state === "queued" ? this.reorder(run, x, { place: input.position }) : [x];
    this.ledger.writeExperiments(rows, {
      actor,
      kind: "experiment_added",
      run,
      body: {
        id: x.id,
        title: x.title,
        ...(x.details ? { details: x.details } : {}),
        ...(x.family ? { family: x.family } : {}),
        ...(x.why ? { why: x.why } : {}),
        by: input.by,
        state,
        ...(state === "queued" && input.position !== undefined ? { position: input.position } : {}),
        ...(input.from ? { from_run: input.from.run, from_id: input.from.id } : {}),
        ...(input.trial ? { trial: input.trial } : {}),
        ...(input.requeued ? { requeued_from: input.requeued } : {}),
      },
    });
    return this.require(run, x.id);
  }

  /** A lane's proposed idea goes into up next (by default at the end). */
  accept(
    run: string,
    id: string,
    o: { by: string; position?: QueuePosition | undefined; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed")
      throw new LedgerError("invalid", `experiment ${id} is ${x.state}, not a proposed idea`);
    const row: Row = { ...strip(x), state: "queued" };
    this.ledger.writeExperiments(this.reorder(run, row, { place: o.position }), {
      actor,
      kind: "experiment_accepted",
      run,
      body: {
        id,
        by: o.by,
        ...(o.position !== undefined ? { position: o.position } : {}),
        ...(o.why ? { why: o.why } : {}),
      },
    });
    return this.require(run, id);
  }

  /** A queued experiment moves to another place in up next. */
  move(
    run: string,
    id: string,
    o: { by: string; position: QueuePosition; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only queued experiments move`,
      );
    this.ledger.writeExperiments(this.reorder(run, strip(x), { place: o.position }), {
      actor,
      kind: "experiment_moved",
      run,
      body: { id, by: o.by, position: o.position, ...(o.why ? { why: o.why } : {}) },
    });
    return this.require(run, id);
  }

  /** New words for an experiment still waiting (proposed or queued). */
  edit(
    run: string,
    id: string,
    change: Partial<ExperimentInput>,
    o: { by: string },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed" && x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only proposed or queued experiments can be edited`,
      );
    const c = ExperimentInput.partial().parse(change);
    const row: Row = {
      ...strip(x),
      ...(c.title !== undefined ? { title: c.title } : {}),
      ...(c.details !== undefined ? { details: c.details } : {}),
      ...(c.family !== undefined ? { family: c.family } : {}),
      ...(c.why !== undefined ? { why: c.why } : {}),
    };
    this.ledger.writeExperiments([row], {
      actor,
      kind: "experiment_edited",
      run,
      body: {
        id,
        by: o.by,
        ...(c.title !== undefined ? { title: c.title } : {}),
        ...(c.details !== undefined ? { details: c.details } : {}),
        ...(c.family !== undefined ? { family: c.family } : {}),
        ...(c.why !== undefined ? { why: c.why } : {}),
      },
    });
    return this.require(run, id);
  }

  /** A proposed or queued experiment is dropped, with why. It stays in the log. */
  drop(run: string, id: string, o: { by: string; why: string }, actor: string): Experiment {
    const x = this.require(run, id);
    if (x.state !== "proposed" && x.state !== "queued")
      throw new LedgerError(
        "invalid",
        `experiment ${id} is ${x.state}: only proposed or queued experiments can be dropped`,
      );
    const why = o.why.trim().slice(0, 2000);
    if (!why) throw new LedgerError("invalid", "say why the experiment is dropped");
    const row: Row = { ...strip(x), state: "dropped", dropped_by: o.by, dropped_why: why };
    this.ledger.writeExperiments(this.reorder(run, row, "leave"), {
      actor,
      kind: "experiment_dropped",
      run,
      body: { id, by: o.by, why },
    });
    return this.require(run, id);
  }

  /**
   * A lane's trial starts on a queued (or proposed) experiment. One experiment goes to one
   * trial: an experiment already assigned, done or dropped is refused.
   */
  assign(
    run: string,
    id: string,
    o: { lane: string; trial: string; by: string; why?: string | undefined },
    actor: string,
  ): Experiment {
    const x = this.require(run, id);
    if (x.state !== "queued" && x.state !== "proposed")
      throw new LedgerError("conflict", `experiment ${id} is ${x.state}: it can't be given out`);
    const row: Row = { ...strip(x), state: "assigned", lane: o.lane, trial: o.trial };
    this.ledger.writeExperiments(this.reorder(run, row, "leave"), {
      actor,
      kind: "experiment_assigned",
      run,
      body: {
        id,
        lane: o.lane,
        trial: o.trial,
        by: o.by,
        ...(o.why ? { why: o.why.slice(0, 2000) } : {}),
      },
    });
    return this.require(run, id);
  }

  /**
   * A trial ended: its experiment is done, with its attempt or why there is none ("submitted",
   * "no_attempt", or the trial's stopped reason). Nothing happens for a trial with no experiment.
   */
  finish(
    trial: string,
    o: { result: string; attempt?: string | null | undefined },
    actor: string,
  ): Experiment | undefined {
    const x = this.forTrial(trial);
    if (x?.state !== "assigned") return undefined;
    const row: Row = {
      ...strip(x),
      state: "done",
      result: o.result,
      attempt: o.attempt ?? null,
    };
    this.ledger.writeExperiments([row], {
      actor,
      kind: "experiment_finished",
      run: x.run,
      body: {
        id: x.id,
        lane: x.lane,
        trial,
        ...(o.attempt ? { attempt: o.attempt } : {}),
        result: o.result,
      },
    });
    return this.require(x.run, x.id);
  }
}
