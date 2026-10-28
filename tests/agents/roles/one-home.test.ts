import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as roles from "../../../src/agents/roles/index.ts";

/**
 * Every prompt Thermite sends comes from a role's definition (goal 166). A send site takes a
 * Prompt, and only `prompt` in src/agents/prompt.ts makes one: its type cannot be written by hand.
 * This test reads every production file's imports and fails when a prompt could be built outside
 * a definition: a file outside src/agents/roles/ that imports the prompt's makers, casts a value
 * to a Prompt, or takes a role's text from the roles rather than its render function. The golden
 * tests (tests/agents/prompts/) then hold what each render gives, as the model receives it.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ROLES_DIR = join(root, "src/agents/roles");
const PROMPT = join(root, "src/agents/prompt.ts");

/** What the rest of the code may take from src/agents/prompt.ts: its types and its readers. */
const PROMPT_READERS = new Set([
  "Prompt",
  "Section",
  "Source",
  "messageText",
  "promptRecord",
  "sectionsText",
  "systemText",
]);

/**
 * What the rest of the code may take from the roles: their render functions, their table, the
 * limits that code checks the answers against (the prompt states the same constants), and the
 * rule that fits a first message to a model's window.
 */
const FROM_ROLES =
  /^(render[A-Z]\w*|ROLES|roleOf|PLAN_LIMITS|RESEARCH_PLAN_LIMITS|PROMOTE_PER_ROUND|windowFit)$/;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );

/** Each import of a file: the module it names, resolved, and the names it takes as values. */
function imports(file: string, src: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)) {
    if (m[1] || !m[3]?.startsWith(".")) continue;
    const names = (m[2] ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0] as string);
    out.push({ from: resolve(dirname(file), m[3]), names });
  }
  return out;
}

/** How a production file could build a prompt outside a definition, in words; none: []. */
function problems(file: string, src: string): string[] {
  const name = relative(root, file);
  const found: string[] = [];
  if (/\bas\s+(unknown\s+as\s+)?Prompt\b/.test(src))
    found.push(`${name}: casts a value to a Prompt`);
  for (const i of imports(file, src)) {
    if (i.from === PROMPT)
      for (const n of i.names.filter((n) => !PROMPT_READERS.has(n)))
        found.push(`${name}: takes ${n} from the prompt's makers`);
    if (i.from.startsWith(`${ROLES_DIR}/`))
      for (const n of i.names.filter((n) => !FROM_ROLES.test(n)))
        found.push(`${name}: takes ${n} from the roles, not a render function`);
  }
  return found;
}

test("every role's prompt is put together by one render function, named in the table", () => {
  for (const r of roles.ROLES) {
    assert.equal(typeof r.render, "function", r.id);
    assert.equal(
      (roles as Record<string, unknown>)[r.render.name],
      r.render,
      `${r.id}: ${r.render.name} is not exported by the roles`,
    );
  }
});

test("no prompt is built outside a role's definition", () => {
  const outside = files(join(root, "src")).filter(
    (f) => !f.startsWith(`${ROLES_DIR}/`) && f !== PROMPT,
  );
  assert.ok(outside.length > 100);
  assert.deepEqual(
    outside.flatMap((f) => problems(f, readFileSync(f, "utf8"))),
    [],
  );
});

test("the check finds a prompt built outside a definition", () => {
  // A send site in the harness that made its own text, as the check reads it.
  const file = join(root, "src/harness/agents/worker/index.ts");
  const src = [
    'import { messageText, prompt, type Prompt, section } from "../../../agents/prompt.ts";',
    'import { renderWorker, WORKER_PI_SYSTEM } from "../../../agents/roles/index.ts";',
    "const p = { role: 'worker' } as unknown as Prompt;",
  ].join("\n");
  assert.deepEqual(problems(file, src), [
    "src/harness/agents/worker/index.ts: casts a value to a Prompt",
    "src/harness/agents/worker/index.ts: takes prompt from the prompt's makers",
    "src/harness/agents/worker/index.ts: takes section from the prompt's makers",
    "src/harness/agents/worker/index.ts: takes WORKER_PI_SYSTEM from the roles, not a render function",
  ]);
});
