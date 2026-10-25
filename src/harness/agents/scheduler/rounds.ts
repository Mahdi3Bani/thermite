import type { Ledger } from "../../ledger.ts";
import { attemptSettled } from "../coordinator.ts";
import type { Registry } from "../registry.ts";

/**
 * When a round of the plan ends (goal 136): no lane waits behind another lane's trial.
 *
 * A round gives each lane up to `trials_per_epoch` trials. It ends as soon as every free lane has
 * started them all, and some lane is free to start the next round. It does not wait for the
 * trials still running on other lanes: a lane on a long trial joins the next round when its trial
 * ends, and takes that round's trials from there. The experiment a round gave a lane that never
 * started in it stays in the queue for the next hand-out.
 *
 * With the judge's wait on (a hill climb or goal run that doesn't keep working, the default), a
 * change the judge has not settled holds the round, so the next plan has its verdict, and holds
 * its own lane's next trial, whatever round that trial is in.
 */

export interface LaneInRound {
  /** Trials the lane started in this round. */
  started: number;
  /** The lane runs a trial now, of this round or of an earlier one. */
  busy: boolean;
  /** The judge has not settled the change from the lane's newest trial, and the run waits for it. */
  waitsForJudge: boolean;
}

export function roundOver(lanes: readonly LaneInRound[], perRound: number): boolean {
  if (lanes.some((l) => l.waitsForJudge)) return false;
  const free = lanes.filter((l) => !l.busy);
  return free.length > 0 && free.every((l) => l.started >= perRound);
}

/** Where each lane of a round stands, for roundOver. */
export function lanesInRound(
  ledger: Ledger,
  registry: Registry,
  run: string,
  round: { n: number; assignments: readonly { lane: string }[] },
  running: { has(lane: string): boolean },
  keep: boolean,
): LaneInRound[] {
  return round.assignments.map(({ lane }) => ({
    started: registry.trials(run, lane, round.n).length,
    busy: running.has(lane),
    waitsForJudge: !running.has(lane) && waitsForJudge(ledger, registry, run, lane, keep),
  }));
}

/**
 * Whether a lane's next trial waits for the judge: the run waits for verdicts (`keep` off), and
 * the change from the lane's newest finished trial, of any round, is not settled.
 */
export function waitsForJudge(
  ledger: Ledger,
  registry: Registry,
  run: string,
  lane: string,
  keep: boolean,
): boolean {
  if (keep) return false;
  const newest = registry.recentTrials(run, lane, 1)[0];
  return !!newest && !attemptSettled(ledger, newest.attempt);
}
