// The import rule (CONVENTIONS.md, "The parts and how they import"). `core` holds contracts and
// does no I/O apart from node:crypto; `common` holds runtime tools; `agents` holds the agent
// runtimes the harness and the supervisor share. The parts (harness, supervisor, control, cli,
// release) import those three, never each other. Domain modules never import page code, and
// production code never imports tests or scripts. Today's exceptions are listed by file in
// scripts/import-exceptions.json; the check fails on a new one, and on a listed one that is gone,
// until the list is lowered, so the list only shrinks.

/** The exceptions, from the repository's root. */
export const EXCEPTIONS_PATH = "scripts/import-exceptions.json";
/** The command that drops exceptions whose import is gone. */
export const LOWER_COMMAND = "npm run check:imports -- --lower";

/** What every part may import, apart from itself. */
const SHARED: Record<string, readonly string[]> = {
  core: [],
  common: ["core"],
  agents: ["core", "common"],
};
const FOR_PARTS = ["core", "common", "agents"];

/** For each file, the imports it may keep for now, each removed when its code moves. */
export type Exceptions = Record<string, string[]>;

export type Rule = "part" | "core-io" | "page" | "tests";
export interface Broken {
  file: string;
  /** The file imported, from the repository's root, or a module name such as node:fs. */
  target: string;
  rule: Rule;
}

/**
 * The modules a TypeScript file imports: static imports and exports (types too, since they tie
 * the parts together as well), side-effect imports, and `import()` of a string.
 */
export function importsOf(text: string): string[] {
  const out: string[] = [];
  const re =
    /(?:^|[\n;])\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|[\n;])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

/** A path from the repository's root, for a relative import in `file`. */
export function resolve(file: string, spec: string): string {
  const parts = file.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** The part a file is in (`src/<part>/…`), or none. */
export function partOf(path: string): string | null {
  const m = /^src\/([^/]+)\//.exec(path);
  return m?.[1] ?? null;
}

/** Page code: the dashboard's pages and the routes that serve them. */
export function isPage(path: string): boolean {
  return path.startsWith("src/control/ui/") || path.startsWith("src/control/dashboard/");
}

/** The rule one import breaks, if it breaks one. Only production code (`src/`) is held to it. */
export function broken(file: string, spec: string): Broken | null {
  const from = partOf(file);
  if (!from) return null;
  if (!spec.startsWith(".")) {
    // A built-in module or a package. core does no I/O: of Node's modules, only node:crypto.
    const io = spec.startsWith("node:") && spec !== "node:crypto";
    return from === "core" && io ? { file, target: spec, rule: "core-io" } : null;
  }
  const target = resolve(file, spec);
  if (target.startsWith("tests/") || target.startsWith("scripts/"))
    return { file, target, rule: "tests" };
  const to = partOf(target);
  if (!to || to === from) {
    if (to === "control" && isPage(target) && !isPage(file)) return { file, target, rule: "page" };
    return null;
  }
  const allowed = SHARED[from] ?? FOR_PARTS;
  return allowed.includes(to) ? null : { file, target, rule: "part" };
}

/** Every broken import in a set of files, read through `read`. */
export function scan(files: readonly string[], read: (file: string) => string): Broken[] {
  const out: Broken[] = [];
  for (const file of files) {
    if (!/\.(?:ts|mts|cts)$/.test(file)) continue;
    const seen = new Set<string>();
    for (const spec of importsOf(read(file))) {
      const b = broken(file, spec);
      if (b && !seen.has(b.target)) {
        seen.add(b.target);
        out.push(b);
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.target.localeCompare(b.target));
}

/** New broken imports, and listed exceptions that are gone. */
export function compare(
  found: readonly Broken[],
  exceptions: Exceptions,
): { added: Broken[]; gone: { file: string; target: string }[] } {
  const listed = new Set(
    Object.entries(exceptions).flatMap(([file, ts]) => ts.map((t) => `${file} ${t}`)),
  );
  const now = new Set(found.map((b) => `${b.file} ${b.target}`));
  const added = found.filter((b) => !listed.has(`${b.file} ${b.target}`));
  const gone = [...listed]
    .filter((k) => !now.has(k))
    .map((k) => {
      const [file = "", target = ""] = k.split(" ");
      return { file, target };
    });
  return { added, gone };
}

/** The exceptions now: what is broken, by file, sorted. */
export function listOf(found: readonly Broken[]): Exceptions {
  const out: Exceptions = {};
  for (const b of found) {
    const targets = out[b.file] ?? [];
    targets.push(b.target);
    out[b.file] = targets;
  }
  return out;
}

/**
 * The list as JSON, laid out as the repository's formatter (Biome, 100 columns) lays it out, so
 * --start and --lower leave the lint clean: a file's list on one line when it fits.
 */
export function exceptionsJson(e: Exceptions): string {
  const rows = Object.entries(e).map(([file, targets]) => {
    const one = `  ${JSON.stringify(file)}: [${targets.map((t) => JSON.stringify(t)).join(", ")}]`;
    if (one.length + 1 <= 100) return one;
    return `  ${JSON.stringify(file)}: [\n${targets.map((t) => `    ${JSON.stringify(t)}`).join(",\n")}\n  ]`;
  });
  return rows.length ? `{\n${rows.join(",\n")}\n}\n` : "{}\n";
}

/** The exceptions lowered: those whose import is gone are dropped, and none is added. */
export function lower(found: readonly Broken[], exceptions: Exceptions): Exceptions {
  const now = new Set(found.map((b) => `${b.file} ${b.target}`));
  const out: Exceptions = {};
  for (const [file, ts] of Object.entries(exceptions)) {
    const kept = ts.filter((t) => now.has(`${file} ${t}`));
    if (kept.length) out[file] = kept;
  }
  return out;
}

const RULE_WORDS: Record<Rule, string> = {
  part: "a part imports another part. Move the shared code to core, common or agents, or to a shared folder named for what it is",
  "core-io":
    "core does no I/O apart from node:crypto. Do the I/O in common, and keep the contract in core",
  page: "a domain module imports page code. Move the shared word or rule out of control/ui/, or move the page code into it",
  tests: "production code imports tests or scripts",
};

/** One broken import in words, with what to do. */
export function brokenText(b: Broken): string {
  return `${b.file} imports ${b.target}: ${RULE_WORDS[b.rule]} (CONVENTIONS.md, "The parts and how they import").`;
}
