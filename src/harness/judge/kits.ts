import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { exportTree } from "../git.ts";

/**
 * A kit's files at one commit, exported once into `<stateDir>/kits/<commit>` and kept there.
 * Each export goes through a folder of its own (goal 163): two judge cards that first need the
 * same kit at once each export it, and the first one in keeps its copy, which the other may
 * already be reading; the second drops its own. Returns the kit's folder.
 */
export async function exportKit(stateDir: string, mirror: string, commit: string): Promise<string> {
  const dir = join(stateDir, "kits", commit);
  if (existsSync(join(dir, "kit.json"))) return dir;
  const tmp = `${dir}.tmp-${randomUUID().slice(0, 8)}`;
  await exportTree(mirror, commit, tmp);
  if (existsSync(join(dir, "kit.json"))) {
    rmSync(tmp, { recursive: true, force: true });
    return dir;
  }
  // A folder without kit.json is an export cut short: replaced whole.
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  return dir;
}
