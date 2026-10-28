import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { type Kit, KitSchema } from "../../core/kit.ts";
import type { McpUse } from "../../core/mcp.ts";

const run = promisify(execFile);

/**
 * A kit uploaded on the new-campaign page: a .tar.gz, .tgz, .tar or .zip with kit.json at its
 * top (or inside one top folder). Control unpacks it in a fresh directory, refuses links and
 * anything that would leave that directory, checks kit.json as the harness does, and keeps the
 * files for the campaign it starts: they become a kit repository control serves, like a kit
 * described on the page.
 */

const MAX_FILES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * What macOS adds to an archive made on a Mac, which is not part of the kit: `tar` puts a file's
 * extended attributes in a `._name` file beside it, the Finder's zip puts them under
 * `__MACOSX/`, and the Finder leaves `.DS_Store` files. They are left out.
 */
const macMetadata = (name: string) =>
  name.startsWith("._") || name === "__MACOSX" || name === ".DS_Store";

export interface UploadedKit {
  /** The archive's sha256: how the page refers to it afterwards. */
  id: string;
  kit: Kit;
  /** Path in the kit → content. */
  files: Record<string, Buffer>;
}

/** What the page shows about an uploaded kit, to choose its cases and score. */
export function kitSummary(k: Kit): {
  name: string;
  target: string;
  cells: string[];
  /** Each metric: how the judge works it out, and in words. */
  metrics: Record<string, { kind: "rate" | "time" | "check"; about: string }>;
  verifiers: string[];
  /** The MCP servers its kit.json names (goal 068), with the agents that get each. */
  mcp_servers: McpUse[];
} {
  return {
    name: k.name,
    target: k.target,
    cells: Object.keys(k.cells),
    metrics: Object.fromEntries(
      Object.entries(k.metrics).map(([n, m]) => [
        n,
        "work" in m
          ? { kind: "rate", about: `a rate (${m.unit})` }
          : m.from === "time"
            ? { kind: "time", about: "how long a run takes (s)" }
            : { kind: "check", about: `the check's ${m.field}${m.unit ? ` (${m.unit})` : ""}` },
      ]),
    ),
    verifiers: Object.keys(k.verifiers),
    mcp_servers: k.mcp_servers ?? [],
  };
}

/** Unpacks and checks an uploaded kit archive. Throws, in words, when it is not a usable kit. */
export async function unpackKit(filename: string, archive: Buffer): Promise<UploadedKit> {
  if (archive.length > MAX_BYTES) throw new Error("the archive is larger than 64 MB");
  const id = createHash("sha256").update(archive).digest("hex");
  const work = mkdtempSync(join(tmpdir(), "thermite-upload-"));
  try {
    const file = join(work, "archive");
    writeFileSync(file, archive);
    const out = join(work, "kit");
    mkdirSync(out);
    const lower = filename.toLowerCase();
    const zip = lower.endsWith(".zip");
    if (!zip && !/\.(tar\.gz|tgz|tar)$/.test(lower))
      throw new Error("upload a .tar.gz, .tgz, .tar or .zip");
    // No owners, no permissions beyond the user's: the files are read as data.
    await (zip
      ? run("unzip", ["-qq", "-o", file, "-d", out])
      : run("tar", ["-xf", file, "-C", out, "--no-same-owner", "--no-same-permissions"])
    ).catch((err: { stderr?: string }) => {
      // The tool's own words, without the temporary paths.
      const said = String(err.stderr ?? "")
        .split(work)
        .join("")
        .trim()
        .split("\n")
        .pop();
      throw new Error(`control could not unpack ${filename}${said ? `: ${said}` : ""}`);
    });
    // kit.json at the top, or inside one top folder.
    let root = out;
    if (!existsSync(join(root, "kit.json"))) {
      const top = readdirSync(root).filter((name) => !macMetadata(name));
      const only = top.length === 1 ? join(root, top[0] as string) : undefined;
      if (only && lstatSync(only).isDirectory() && existsSync(join(only, "kit.json"))) root = only;
      else throw new Error("the archive has no kit.json at its top");
    }
    const files: Record<string, Buffer> = {};
    let count = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (macMetadata(name)) continue;
        const p = join(dir, name);
        const st = lstatSync(p);
        const rel = relative(root, p).split(sep).join("/");
        if (rel.startsWith("..") || rel.split("/").includes(".git")) continue;
        if (st.isSymbolicLink()) throw new Error(`${rel} is a link: a kit holds only files`);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) {
          if (++count > MAX_FILES) throw new Error(`the kit has more than ${MAX_FILES} files`);
          files[rel] = readFileSync(p);
        }
      }
    };
    walk(root);
    let manifest: unknown;
    try {
      manifest = JSON.parse(String(files["kit.json"]));
    } catch {
      throw new Error("kit.json is not JSON");
    }
    const parsed = KitSchema.safeParse(manifest);
    if (!parsed.success)
      throw new Error(
        `kit.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    return { id, kit: parsed.data, files };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
