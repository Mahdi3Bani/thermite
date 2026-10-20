import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * The local compose stack's folder, `.dev/`: random tokens in `secrets/`, the inbox, the outbox
 * and the advisors' folder. The release bundle's `init` service makes it with
 * `thermite local init`; a checkout makes the same layout with `npm run dev:init`
 * (scripts/dev-init.mjs, which needs no build). Files that exist are kept, so the tokens stay
 * the same from one start to the next; only the rig tokens map is written again, from the rig
 * tokens.
 */

/** The token files, each made once: control's, then each rig's (local-1 and local-2). */
export const LOCAL_TOKEN_FILES = [
  "control-admin-token",
  // An operating agent's token for control's MCP (it may steer and message agents, never approve).
  "control-operator-token",
  "control-rig-token",
  "control-rig-token-2",
  "harness-supervisor-token",
  "harness-proposer-token",
  "harness2-supervisor-token",
  "harness2-proposer-token",
] as const;

/** The folders, relative to `.dev/`. The inbox ones are open to every user: see below. */
export const LOCAL_FOLDERS = [
  "secrets",
  "inbox/repos",
  "inbox/models",
  "outbox",
  // Advisor configuration and keys (mounted read-only into the supervisors).
  "advisors",
] as const;

// The supervisor fetches sources into the inbox as its own user in its container: on native
// Linux that user is not you, so the local inbox is open to it (local development only).
const OPEN_FOLDERS = ["inbox", "inbox/repos", "inbox/models"];

export interface Owner {
  uid: number;
  gid: number;
}

export interface LocalInitResult {
  /** Paths made by this call, relative to `.dev/`, folders first. */
  made: string[];
  /** Token and key files that were there already, relative to `.dev/`. */
  kept: string[];
}

const token = () => randomBytes(24).toString("base64url");

/**
 * Who should own what `localInit` makes. Run as root (the bundle's `init` service, in a
 * container), files would belong to root; when the folder that holds `.dev/` belongs to someone
 * else, they go to that owner, so the person who downloaded the bundle can read and change them.
 * Otherwise nothing changes hands.
 */
export function chooseOwner(processUid: number | undefined, parent: Owner | undefined) {
  if (processUid !== 0 || !parent) return undefined;
  if (parent.uid === 0 && parent.gid === 0) return undefined;
  return parent;
}

/** The owner of the folder that holds `root`, when it exists. */
export function parentOwner(root: string): Owner | undefined {
  const parent = dirname(root);
  if (!existsSync(parent)) return undefined;
  const s = statSync(parent);
  return { uid: s.uid, gid: s.gid };
}

/** Makes `.dev/` at `root` (keeping what is there) and gives what it made to `owner`, if any. */
export function localInit(root: string, owner?: Owner): LocalInitResult {
  const made: string[] = [];
  const kept: string[] = [];
  const give = (rel: string) => {
    if (owner) chownSync(join(root, rel), owner.uid, owner.gid);
  };
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o755 });
    made.push(".");
    give(".");
  }
  for (const folder of LOCAL_FOLDERS) {
    // Each step of the path, so that a new `inbox` is given away as well as `inbox/repos`.
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      if (existsSync(join(root, rel))) continue;
      mkdirSync(join(root, rel), { mode: 0o755 });
      made.push(rel);
      give(rel);
    }
  }
  for (const rel of OPEN_FOLDERS) chmodSync(join(root, rel), 0o777);
  const write = (name: string, value: string) => {
    const rel = `secrets/${name}`;
    if (existsSync(join(root, rel))) {
      kept.push(rel);
      return;
    }
    writeFileSync(join(root, rel), value, { mode: 0o644, flag: "wx" });
    made.push(rel);
    give(rel);
  };
  for (const name of LOCAL_TOKEN_FILES) write(name, token());
  // A local model route's key: a placeholder to replace for a real OpenAI-compatible endpoint
  // (a key kept under the file's old name, qwen-api-key, carries over).
  const oldKey = join(root, "secrets", "qwen-api-key");
  write("model-api-key", existsSync(oldKey) ? readFileSync(oldKey, "utf8") : "local-placeholder");
  const read = (name: string) => readFileSync(join(root, "secrets", name), "utf8").trim();
  const map = "secrets/control-rig-tokens.json";
  const fresh = !existsSync(join(root, map));
  writeFileSync(
    join(root, map),
    JSON.stringify({
      "local-1": read("control-rig-token"),
      "local-2": read("control-rig-token-2"),
    }),
    { mode: 0o644 },
  );
  if (fresh) {
    made.push(map);
    give(map);
  }
  return { made, kept };
}
