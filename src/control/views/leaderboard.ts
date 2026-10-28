import { championValues } from "../metric-values.ts";
import type { ControlStore } from "../store.ts";
import { currentChampion } from "./facts.ts";
import { rigView } from "./rig.ts";

export interface LeaderEntry {
  rig: string;
  run: string;
  mode: string | null;
  status: string;
  champion_seq: number;
  /** Relative gain of the champion over the run's seed, measured on its own rig. */
  gain: number;
  /** Rigs whose own judge accepted this exact champion (propagation): cross-verified. */
  verified_by: string[];
  /** The starting point's and the champion's main metric values, with the unit (goal 133). */
  values: ReturnType<typeof championValues>;
}

/**
 * The campaign leaderboard: each run's champion and its gain over its baseline, measured
 * on its own rig (never absolute numbers across devices), marked cross-verified once another
 * rig's judge accepted it.
 */
export function leaderboard(
  store: ControlStore,
  opts: { staleAfterMs: number },
): Record<string, LeaderEntry[]> {
  const views = store.rigs().flatMap((u) => rigView(store, u.id, opts) ?? []);
  // An acceptance counts only for the tree it accepted: the key includes the tree, which must be
  // the one the source rig itself published (signed) for that seq.
  const verified = new Map<string, Set<string>>();
  for (const v of views) {
    for (const i of v.runs) {
      for (const p of i.propagations) {
        if (p.result !== "accepted" || !p.tree) continue;
        const key = `${p.source_rig}/${p.source_run}/${p.source_seq}/${p.tree}`;
        verified.set(key, (verified.get(key) ?? new Set<string>()).add(v.id));
      }
    }
  }
  const out: Record<string, LeaderEntry[]> = {};
  for (const v of views) {
    for (const i of v.runs) {
      // Hill climbs: a gain over the baseline is what is compared.
      if (i.mode !== "hill_climb" || !i.campaign) continue;
      const champ = currentChampion(i);
      const seq = champ?.seq ?? 1;
      const tree = i.published_trees[seq];
      if (!out[i.campaign]) out[i.campaign] = [];
      out[i.campaign]?.push({
        rig: v.id,
        run: i.id,
        mode: i.mode,
        status: i.status,
        champion_seq: seq,
        gain: (champ?.cumulative ?? 1) - 1,
        verified_by: tree ? [...(verified.get(`${v.id}/${i.id}/${seq}/${tree}`) ?? [])].sort() : [],
        values: championValues(i),
      });
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => b.gain - a.gain);
  return out;
}
