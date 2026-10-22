import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

/**
 * Lane caches over a start (goal 079). The broker empties the scratch folder at every start:
 * whatever an earlier run left there goes, hostile trees included. A lane's cache folder (ccache
 * and the like, `<scratch>/thermite/lanes/<lane>/cache`) is the one thing kept: it is set aside
 * before the scratch folder is emptied and put back after, so a restart or an image update does
 * not make every lane rebuild its project from nothing.
 *
 * Only a real folder (never a link) named for a lane, and owned by that lane's user, is kept;
 * anything else in the lanes' folders goes with the rest.
 */

/** Where the caches wait while the scratch folder is emptied: in it, on the same file system. */
export const ASIDE = ".lane-caches";

/** A lane's name, as its folder under `lanes/` is named. */
const LANE = /^lane-([1-9]|1[0-6])$/;

/**
 * Sets each lane's cache aside, then empties the scratch folder but for it (`remove` takes one
 * entry's path). Returns the lanes whose caches were kept.
 */
export function emptyScratchKeepingCaches(
  scratchDir: string,
  o: {
    /** Whether this cache may be kept: its lane and its folder's stat (owner, kind). */
    keep: (lane: string, st: Stats) => boolean;
    remove: (path: string) => void;
  },
): string[] {
  const aside = join(scratchDir, ASIDE);
  // A folder left aside by a start that stopped half way is put back first, then sorted again.
  const kept = new Set<string>(
    existsSync(aside) ? readdirSync(aside).filter((l) => LANE.test(l)) : [],
  );
  const lanes = join(scratchDir, "thermite", "lanes");
  if (existsSync(lanes) && lstatSync(lanes).isDirectory() && !lstatSync(lanes).isSymbolicLink()) {
    for (const lane of readdirSync(lanes)) {
      if (!LANE.test(lane) || kept.has(lane)) continue;
      const cache = join(lanes, lane, "cache");
      let st: Stats;
      try {
        st = lstatSync(cache);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink() || !o.keep(lane, st)) continue;
      mkdirSync(aside, { recursive: true, mode: 0o700 });
      renameSync(cache, join(aside, lane));
      kept.add(lane);
    }
  }
  for (const name of readdirSync(scratchDir)) if (name !== ASIDE) o.remove(join(scratchDir, name));
  return [...kept].sort();
}

/**
 * Puts the kept caches back, once the controller's folder is ready: `<scratch>/thermite/lanes/
 * <lane>/cache`, each still its lane's. `own` makes a new lanes folder the controller's.
 */
export function restoreLaneCaches(
  scratchDir: string,
  lanes: string[],
  own: (path: string) => void,
): void {
  const aside = join(scratchDir, ASIDE);
  if (!existsSync(aside)) return;
  const root = join(scratchDir, "thermite", "lanes");
  for (const lane of lanes) {
    const from = join(aside, lane);
    if (!existsSync(from)) continue;
    for (const dir of [root, join(root, lane)]) {
      if (!existsSync(dir)) {
        mkdirSync(dir);
        own(dir);
      }
    }
    renameSync(from, join(root, lane, "cache"));
  }
  rmSync(aside, { recursive: true, force: true });
}
