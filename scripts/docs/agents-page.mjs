#!/usr/bin/env node
// The documentation site's Agent roles page is written from src/agents/roles/index.ts, the one
// table of Thermite's agent roles and their fixed texts (goal 166). `npm run docs:agents` writes
// it; `npm run docs:check` fails when the two differ. Run with --experimental-strip-types.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const agentsPageFile = join(root, "docs/_site/src/content/docs/reference/agent-roles.md");
const rolesModule = pathToFileURL(join(root, "src/agents/roles/index.ts")).href;

const FRONT = `---
title: "Agent roles"
description: "Every agent role Thermite runs: what it does, where it runs, its model and programs, whether your messages reach it, and its fixed instructions, word for word."
type: reference
sidebar:
  order: 4
---
`;

const NOTE =
  "<!-- Written from src/agents/roles/ by `npm run docs:agents`: change the role's module, not this page. -->\n";

const INTRO = `Thermite runs 15 agent roles. Each role's fixed instructions are in its own module in \`src/agents/roles/\`, and \`src/agents/roles/index.ts\` lists every role in one table. This page is written from that table, so the texts below are the ones the code sends, word for word.

A run adds to these texts each time it calls a role: the campaign's brief, the run's rules and queue, field notes, past research and your messages. Those parts are put together where the role is called. Every role advises or proposes; none of them measures, judges or promotes (see [Why agents never judge](../explanation/why-agents-never-judge.md)).

| Role | What it does | Runs in | Model | Programs | Your messages reach it |
| --- | --- | --- | --- | --- | --- |
`;

const cell = (s) => s.replace(/\|/g, "\\|");
const anchor = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim()
    .replace(/ +/g, "-");

/** The page that the table of roles makes. */
export async function agentsPage() {
  const { ROLES } = await import(rolesModule);
  const rows = ROLES.map(
    (r) =>
      `| [${cell(r.name)}](#${anchor(r.name)}) | ${cell(r.what)} | ${r.runsIn} | ${cell(r.model)} | ${r.programs.join(", ")} | ${r.messages ? "Yes" : "No"} |`,
  ).join("\n");
  const sections = ROLES.map((r) => {
    const texts = r.texts
      .map((x) => {
        if (x.text.includes("```")) throw new Error(`${r.id}/${x.id}: a text holds a code fence`);
        return `### ${r.name}: ${x.what}\n\n\`\`\`text\n${x.text}\n\`\`\``;
      })
      .join("\n\n");
    return `## ${r.name}\n\n${r.what} Its module: \`src/agents/roles/\`, role \`${r.id}\`.\n\n${texts}`;
  }).join("\n\n");
  return `${FRONT}\n${NOTE}\n${INTRO}${rows}\n\n${sections}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(agentsPageFile, await agentsPage());
  console.log(`${agentsPageFile}: written from src/agents/roles/`);
}
