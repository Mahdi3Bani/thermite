#!/usr/bin/env node
// Checks the documentation site (docs/_site) for what its build cannot see:
//   - each page's front matter, and that it sits in the section of its Diátaxis type;
//   - relative links between pages, and their #anchors;
//   - every `thermite` command and option a page shows exists in the command line;
//   - every setting a page names exists in the code, and every setting the code reads is in the
//     settings reference;
//   - every contract, kit.json and advisors.json example parses with the real schema;
//   - after `npm run docs:build`: llms.txt lists every page, llms-full.txt holds every page, and
//     every page has its Markdown copy.
// Usage: node --experimental-strip-types scripts/docs-check.mjs [--allow-stubs] [--no-build]
// (`npm run docs:check`). It exits 1 and lists each problem when anything fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(root, "docs/_site/src/content/docs");
const siteOut = join(root, ".dev/site");
const allowStubs = process.argv.includes("--allow-stubs");
const checkBuild = !process.argv.includes("--no-build");

const problems = [];
const problem = (file, message) => problems.push(`${relative(root, file)}: ${message}`);

/** Every file under `dir` whose name matches `pattern`. */
function walk(dir, pattern, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, pattern, out);
    else if (pattern.test(entry.name)) out.push(path);
  }
  return out;
}

// --- Pages and front matter -------------------------------------------------------------------

const typeOfSection = {
  tutorials: "tutorial",
  "how-to": "how-to",
  reference: "reference",
  explanation: "explanation",
  project: "project",
};

function frontMatter(text) {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!block) return null;
  const field = (name) => {
    const line = new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(block[1])?.[1]?.trim();
    if (line === undefined) return undefined;
    if (line.startsWith('"')) return JSON.parse(line);
    if (line.startsWith("'")) return line.slice(1, -1).replaceAll("''", "'");
    return line;
  };
  return {
    title: field("title"),
    description: field("description"),
    type: field("type"),
    body: text.slice(block[0].length),
  };
}

// A placeholder such as <campaign> outside code is read as an HTML tag, and the site hides it.
const htmlTags =
  /^<\/?(a|b|br|code|details|div|em|i|img|kbd|li|ol|p|span|strong|sub|summary|sup|table|td|th|tr|ul|Aside|Card|CardGrid|LinkCard|Steps|TabItem|Tabs)\b/;
function placeholders(body) {
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/``[^`]*``|`[^`\n]*`/g, "");
  return [...prose.matchAll(/<\/?[A-Za-z][\w-]*(?:\s[^>\n]*)?>/g)]
    .map((m) => m[0])
    .filter((tag) => !htmlTags.test(tag));
}

const pages = walk(docsRoot, /\.mdx?$/)
  .map((file) => {
    const slug = relative(docsRoot, file)
      .split(sep)
      .join("/")
      .replace(/\.mdx?$/, "");
    return { file, slug, text: readFileSync(file, "utf8") };
  })
  .filter((page) => page.slug !== "404");

for (const page of pages) {
  const fm = frontMatter(page.text);
  if (!fm) {
    problem(page.file, "no front matter");
    continue;
  }
  Object.assign(page, fm);
  if (!page.title) problem(page.file, "no title");
  if (!page.description || page.description.length < 20)
    problem(page.file, "no one-line description (at least 20 characters, on one line)");
  const section = page.slug.split("/")[0] ?? "";
  const expected = typeOfSection[section] ?? "hub";
  if (page.type !== expected)
    problem(page.file, `type is "${page.type}", but pages in this section are "${expected}"`);
  if (/^#\s/m.test(page.body.replace(/```[\s\S]*?```/g, "")))
    problem(page.file, "a level-1 heading in the body; the title comes from the front matter");
  if (/:::note\[Being written\]/.test(page.body) && !allowStubs) problem(page.file, "still a stub");
  for (const tag of new Set(placeholders(page.body)))
    problem(
      page.file,
      `${tag} outside code is read as an HTML tag and hidden; put it in backticks`,
    );
}

// --- Links and anchors ------------------------------------------------------------------------

/** GitHub's and Starlight's heading ids (github-slugger). */
function slugger() {
  const seen = new Map();
  return (heading) => {
    const base = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function headingText(markdown) {
  return (
    markdown
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Emphasis marks go; underscores inside words stay, as in Starlight's and GitHub's ids.
      .replace(/\*+/g, "")
      .replace(/(^|\s)_+|_+(\s|$)/g, "$1$2")
      .trim()
  );
}

const anchorsCache = new Map();
function anchorsOf(file) {
  if (!anchorsCache.has(file)) {
    const body = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
    const slug = slugger();
    const ids = new Set();
    for (const match of body.matchAll(/^#{2,6}\s+(.+?)\s*#*\s*$/gm))
      ids.add(slug(headingText(match[1] ?? "")));
    anchorsCache.set(file, ids);
  }
  return anchorsCache.get(file);
}

const linkPattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
for (const page of pages) {
  const prose = (page.body ?? "").replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of prose.matchAll(linkPattern)) {
    const url = match[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("/")) continue;
    const [path, hash] = url.split("#");
    const target = path ? resolve(dirname(page.file), path) : page.file;
    if (!target.startsWith(join(root, "docs/_site/src"))) {
      problem(page.file, `link ${url} leaves the site; link to the file on GitHub instead`);
      continue;
    }
    if (!existsSync(target)) {
      problem(page.file, `link ${url}: no such file`);
      continue;
    }
    if (hash && /\.mdx?$/.test(target) && !anchorsOf(target).has(hash))
      problem(page.file, `link ${url}: no heading with the id "${hash}"`);
  }
}

// --- Code blocks ------------------------------------------------------------------------------

function codeBlocks(text) {
  const blocks = [];
  for (const match of text.matchAll(/^([ \t]*)```([^\n]*)\n([\s\S]*?)\n\1```/gm)) {
    const meta = match[2] ?? "";
    blocks.push({
      lang: meta.split(/\s/)[0] ?? "",
      title: /title="([^"]*)"/.exec(meta)?.[1] ?? "",
      code: (match[3] ?? "").replace(new RegExp(`^${match[1]}`, "gm"), ""),
    });
  }
  return blocks;
}

function inlineCode(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
}

// The command line: its usage text names every command, subcommand and option.
const cliSource = readFileSync(join(root, "src/cli/thermite.ts"), "utf8");
const usage = /const USAGE = `([\s\S]*?)`;/.exec(cliSource)?.[1] ?? "";
const commands = new Map(); // "rig add" or "submit" -> Set of options
let current = null;
for (const line of usage.split("\n")) {
  const head = /^ {2}([a-z][a-z-]*)(?: ([a-z][a-z-]*))?(?=\s|$)/.exec(line);
  if (head) {
    const sub = head[2] && !/^--/.test(head[2]) ? head[2] : "";
    current = sub && /^ {2}[a-z-]+ [a-z-]+(\s|$)/.test(line) ? `${head[1]} ${sub}` : head[1];
    if (!commands.has(current)) commands.set(current, new Set());
  }
  if (current)
    for (const option of line.matchAll(/--[a-z][a-z-]*/g)) commands.get(current)?.add(option[0]);
}
for (const always of ["help", "--help"]) commands.set(always, new Set());

function checkCommandLine(page, text) {
  const joined = text.replace(/\\\n\s*/g, " ");
  for (const match of joined.matchAll(
    /(?:^|[\s($`;&|])(?:npx\s+)?thermite(?![\w-])([^\n;&|`]*)/g,
  )) {
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const [first, second] = words;
    // "thermite" can also be a name in a URL, a path or a git ref, not the command.
    if (!first || first.startsWith("<") || first === "..." || /[/:.=(]/.test(first)) continue;
    const key = second && commands.has(`${first} ${second}`) ? `${first} ${second}` : first;
    if (!commands.has(key)) {
      const subs = [...commands.keys()].filter((name) => name.startsWith(`${first} `));
      problem(
        page.file,
        subs.length
          ? `thermite ${first} ${second ?? ""}: no such subcommand (${subs.join(", ")})`
          : `thermite ${first}: no such command`,
      );
      continue;
    }
    for (const word of words) {
      const option = /^(--[a-z][a-z-]*)/.exec(word)?.[1];
      if (option && option !== "--help" && !commands.get(key)?.has(option))
        problem(page.file, `thermite ${key}: no option ${option}`);
    }
  }
}

// Settings: names the code reads, and name patterns it builds (THERMITE_CONTROL_${role}_...).
const codeFiles = [
  ...walk(join(root, "src"), /\.ts$/).filter(
    (f) => !f.endsWith(".test.ts") && !f.includes(`${sep}testing${sep}`),
  ),
];
const otherFiles = [
  ...walk(join(root, "containers"), /.*/),
  ...walk(join(root, "scripts"), /\.(mjs|ts|sh)$/),
  ...["compose.yaml", "compose.lifecycle.yaml"].map((f) => join(root, f)),
].filter((f) => existsSync(f) && !f.endsWith("docs-check.mjs"));
const settingName = /\b(?:THERMITE|QWEN)_[A-Z0-9_]*[A-Z0-9]\b/g;
const codeSettings = new Set();
const settingPatterns = [];
for (const file of codeFiles) {
  const text = readFileSync(file, "utf8");
  for (const name of text.match(settingName) ?? []) codeSettings.add(name);
  for (const dynamic of text.matchAll(/\b((?:THERMITE|QWEN)_[A-Z0-9_]*)\$\{[^}]+\}([A-Z0-9_]*)/g))
    settingPatterns.push(new RegExp(`^${dynamic[1]}[A-Z0-9]+${dynamic[2]}$`));
}
const knownSettings = new Set(codeSettings);
for (const file of otherFiles)
  for (const name of readFileSync(file, "utf8").match(settingName) ?? []) knownSettings.add(name);
const exists = (name) => knownSettings.has(name) || settingPatterns.some((p) => p.test(name));

// Names Thermite sets for its own child processes or tests, not settings anyone sets. Each has
// its reason; the settings reference leaves them out.
const internalSettings = new Map([
  ["THERMITE_SUPERVISOR_TOKEN", "the broker passes the token's value to the harness's controller"],
  ["THERMITE_PROPOSER_TOKEN", "the broker passes the token's value to the harness's controller"],
  ["THERMITE_MODEL_API_KEY", "the broker passes the key's value to the harness's controller"],
  ["QWEN_API_KEY", "the older name of the value the broker passes"],
  ["THERMITE_BROKER_SOCKET", "the broker tells the controller where its socket is"],
  ["THERMITE_HARNESS_URL", "the controller tells workers where the harness API is"],
  ["THERMITE_TRIAL_AUTH", "the controller gives a trial its token"],
  ["THERMITE_PROXY_AUTH", "the controller gives a trial its model proxy token"],
  ["THERMITE_EDITABLE_PATHS", "the controller tells thermite-trial what a trial may edit"],
  ["THERMITE_WORKSPACE", "the controller tells thermite-trial where the trial's workspace is"],
  ["THERMITE_OPENCODE_EVENTS", "the controller's event log path for an OpenCode trial"],
  ["THERMITE_CLAUDE_EVENTS", "the controller's event log path for a Claude Code trial"],
  ["THERMITE_LANE_CACHE", "the controller gives each lane's commands its build cache"],
  ["THERMITE_PROBE_TOKEN", "control gives a RunPod test pod its report path"],
  ["THERMITE_PROBE_JS", "control gives a RunPod test pod its probe script"],
]);

function checkSettings(page, texts) {
  for (const text of texts)
    for (const name of text.match(settingName) ?? [])
      if (!exists(name)) problem(page.file, `${name}: no such setting in the code`);
}

// Example files are parsed with the real schemas. A title with "(part)" marks a fragment.
const schemas = {
  contract: (await import("../src/core/contract.ts")).ContractSchema,
  kit: (await import("../src/harness/kit.ts")).KitSchema,
  advisors: (await import("../src/supervisor/advisors.ts")).AdvisorsConfig,
};
function exampleKind(title) {
  if (/\(part\)/i.test(title)) return null;
  if (/advisors[\w.-]*\.json$/i.test(title)) return "advisors";
  if (/(^|\/)kit\.json$/i.test(title)) return "kit";
  if (/contract[\w.-]*\.json$/i.test(title)) return "contract";
  return null;
}

for (const page of pages) {
  const body = page.body ?? "";
  const blocks = codeBlocks(body);
  const inline = inlineCode(body);
  for (const block of blocks) {
    if (["sh", "bash", "shell", "console", "zsh", "text", ""].includes(block.lang))
      checkCommandLine(page, block.code);
    const kind = exampleKind(block.title);
    if (kind) {
      let value;
      try {
        value = JSON.parse(block.code);
      } catch (error) {
        problem(page.file, `${block.title}: not valid JSON (${error.message})`);
        continue;
      }
      const parsed = schemas[kind].safeParse(value);
      if (!parsed.success)
        problem(
          page.file,
          `${block.title}: the ${kind} schema refuses it: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(top)"} ${i.message}`)
            .join("; ")}`,
        );
    }
  }
  for (const code of inline) if (/^(npx\s+)?thermite\s/.test(code)) checkCommandLine(page, code);
  checkSettings(page, [body]);
}

const settingsPage = pages.find((p) => p.slug === "reference/settings");
if (settingsPage) {
  const documented = new Set(settingsPage.text.match(settingName) ?? []);
  for (const name of codeSettings)
    if (!documented.has(name) && !internalSettings.has(name))
      problem(settingsPage.file, `${name} is read by the code but not documented here`);
} else problems.push("docs/_site/src/content/docs/reference/settings.md: missing");

// --- The built site ---------------------------------------------------------------------------

if (checkBuild) {
  if (!existsSync(join(siteOut, "llms.txt"))) {
    problems.push(".dev/site: not built; run `npm run docs:build` first, or pass --no-build");
  } else {
    const llms = readFileSync(join(siteOut, "llms.txt"), "utf8");
    const full = readFileSync(join(siteOut, "llms-full.txt"), "utf8");
    for (const page of pages) {
      if (!existsSync(join(siteOut, `${page.slug}.md`)))
        problems.push(`.dev/site/${page.slug}.md: no Markdown copy`);
      if (!llms.includes(`/${page.slug}.md)`))
        problems.push(`.dev/site/llms.txt: does not list ${page.slug}`);
      if (page.title && !full.includes(`# ${page.title}\n`))
        problems.push(`.dev/site/llms-full.txt: does not hold "${page.title}"`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`docs-check: ${problems.length} problem(s)\n${problems.join("\n")}\n`);
  process.exit(1);
}
const stubs = pages.filter((p) => /:::note\[Being written\]/.test(p.body ?? "")).length;
process.stdout.write(
  `docs-check: ok (${pages.length} pages${stubs ? `, ${stubs} still stubs` : ""})\n`,
);
