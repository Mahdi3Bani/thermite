import type { ChampionStep } from "../views.ts";

/**
 * Control's facts about a run, worked out once (goal 125, T1), as its screens, MCP and metrics
 * read them.
 */

/** A run's champions still in force: those no invalidation reopened, oldest first. */
export const championsInForce = (r: { champion: readonly ChampionStep[] }): ChampionStep[] =>
  r.champion.filter((c) => !c.reopened);

/** A run's current champion: the newest still in force, if any. */
export const currentChampion = (r: {
  champion: readonly ChampionStep[];
}): ChampionStep | undefined => championsInForce(r).at(-1);
