# Writing Thermite's documentation

Thermite's documentation is a website built with [Astro Starlight](https://starlight.astro.build/) from `docs/_site/`. This page says how the site is put together, how to write a page, and how to check it. The plans in [plan/](plan/README.md) and this folder's other files are repository documents, not part of the site.

## Build and check

```sh
npm run docs:install   # once: the site's own dependencies, from docs/_site/package-lock.json
npm run docs:dev       # a live preview at http://localhost:4321/
npm run docs:build     # the site, in .dev/site/
npm run docs:check     # what the build cannot check; run it after docs:build
```

The site's dependencies are pinned to exact versions and kept apart from Thermite's own, so the images and the core never change because of the docs. Starlight is still 0.x: upgrade it on purpose, one version at a time, and rebuild.

`npm run docs:build` fails on a page without a title, a description or a type, and on a broken link to a site address. `npm run docs:check` fails on:

- a page whose `type` does not match its section;
- a relative link to a missing page or heading, or one that leaves the site;
- a `thermite` command or option that the command line does not have;
- a setting that the code does not read, or a setting the code reads that [the settings reference](_site/src/content/docs/reference/settings.md) leaves out;
- a contract, `kit.json` or `advisors.json` example that the real schema refuses;
- an agent named by an old name outside code: "teacher pair", "combiner", "panelist", "the supervisor's advisors", or "panel" alone for the review panel. Each agent has one name: the workers and the planner (the work), the teachers, their merged by model, the auditor and the review panel (the advisors). Code spans may show the old API names that are still taken. Until Edit rig's agents table is renamed, its row labels **Teacher pair** and **Combiner** are allowed in bold;
- a placeholder in angle brackets, such as `<campaign>`, outside a code span: the site reads it as an HTML tag and hides it, so write it in backticks;
- a page missing from `llms.txt` or `llms-full.txt`, or without its Markdown copy;
- a page that is still a stub.

## Where the site is served

The site is at [usethermite.com](https://usethermite.com), on Cloudflare Pages. Cloudflare builds it from `main` on every push: in `docs/_site/`, with `npm run build -- --outDir dist` on Node.js 22, and it serves `dist/`. Other branches and pull requests get no preview.

- `docs/_site/public/_headers` sets the response headers, among them the Content Security Policy. A page that loads a script, style, image or font from another host needs that host added there, or the browser blocks it.
- The site's icon is the flame in `docs/_site/public/favicon.svg`. Beside it are `favicon.ico` (16, 32 and 48 pixels, for browsers that take no SVG, such as Safari) and `apple-touch-icon.png` (180 pixels, on a dark square, for a page saved on iOS). They are made from the SVG; after a change to the flame, make them again from it, and keep the three alike.
- The pages count visits to usethermite.com with [Fathom Analytics](https://usefathom.com), which sets no cookies. Its script and site code are in `astro.config.mjs`.
- The header shows the version of Thermite the pages describe, beside the title, linked to the roadmap page. The build reads it from the root `package.json`, so a new version needs no change to the site (`src/components/SiteTitle.astro`).

## Where pages go

Every page is one Markdown file in `docs/_site/src/content/docs/`, and has one [Diátaxis](https://diataxis.fr/) type. Its folder says which:

| Folder | Type | A page here… |
| --- | --- | --- |
| `tutorials/` | `tutorial` | teaches a newcomer by doing. One path, no choices, and every step works. |
| `how-to/<group>/` | `how-to` | helps someone who knows what they want to do it. |
| `reference/` | `reference` | describes one part completely: every field, setting, command or route. |
| `explanation/` | `explanation` | says how something works and why. |
| `project/` | `project` | is about the project: the roadmap, getting help, contributing. |
| the top | `hub` | is the home page or Start here. |

The sidebar follows the folders. `sidebar.order` in the front matter sets a page's place in its group.

## Front matter

```yaml
---
title: "Check a rig"
description: "Run a rig's model, isolation and smoke checks, and read what they found."
type: how-to
sidebar:
  order: 1
---
```

- `title` is what the reader wants, in their words. A how-to guide's title is the task: "Add a rig on a machine over SSH".
- `description` is one sentence on one line. It shows in search results and in `llms.txt`.
- Don't start the body with a `#` heading: the title is the page's heading.

## Writing rules

- **One page, one type.** A short part of another type is fine. When a page turns into two documents, split it and link the halves.
- **Start with what the reader will do or learn, and why,** in one or two sentences. Then say what they need first.
- **Plain, everyday words and short sentences.** Write for a capable person who has never seen Thermite. The first time a page uses a Thermite word (rig, lane, kit, verdict), explain it in a few words or link it to the [glossary](_site/src/content/docs/reference/glossary.md). This is readable English, not strict Simplified Technical English.
- **Each step says what the reader sees after it.** Name screens, buttons and fields in **bold**, exactly as the dashboard shows them: **Settings › Providers**, **Add a rig**.
- **Show, then tell.** Put a working example near the top: the command, the file, the screen.
- **Only what exists.** Every command, option, setting, route and field on a page exists in the code. A planned feature gets one line and a link to its goal in the [roadmap](plan/roadmap.md), never a description as if it existed. Pages describe how Thermite behaves, not what has been done lately.
- **No default caps, stated correctly.** Thermite never ends research by default. Don't call a per-process limit, pacing or back-pressure something that "stops" a campaign. Caps exist only when someone sets them. A page that uses a paid key says to set a budget or a stop time first.
- **Public content.** Use made-up names: `gpu-host-1`, `rig-1`, `control.example.com`, `git.example.com`. Never a real host, address, account or private repository. Screenshots come only from the dashboard demo (`scripts/dashboard-demo.ts`), whose data is made up.

### Each type

- **Tutorial:** say what the reader will have at the end and how long it takes. Number the steps. Give one way to do each step, show what the reader should see, and finish with something that works. Explain only what is needed to go on, and link to explanation for the rest.
- **How-to guide:** the title is the task. Say what you need first, then number the steps. Assume the reader knows the basics; link to tutorials and explanation, don't repeat them. End with how to tell that it worked.
- **Reference:** complete and consistent. Use tables: name, type, default, meaning. Describe; don't instruct or persuade. Keep each page in the same order as the thing it describes.
- **Explanation:** the reasons and the trade-offs. Use diagrams. No steps.

## Markdown

- Link to other pages with relative paths to their files: `[the settings reference](../reference/settings.md#models)`. Those links work on GitHub, in the Markdown copies and on the site. Link to files outside the site (the repository's code, the plans) with their full GitHub address.
- Code blocks name their language: `sh`, `json`, `yaml`, `text`. Give example files a title: ```` ```json title="contract.json" ````. Examples titled `contract.json`, `kit.json` or `advisors.json` are parsed with the real schema; add `(part)` to the title of a fragment, such as `title="kit.json (part)"`.
- Notes, tips and warnings use Starlight's asides: `:::note`, `:::tip`, `:::caution`, `:::danger`.
- Diagrams are Mermaid blocks (```` ```mermaid ````). They render on GitHub and on the site.
- Images go in `docs/_site/src/assets/` and are linked with relative paths.

## For agents

The built site has `/llms.txt`, which lists every page with its description, and `/llms-full.txt`, which holds every page in one file. There are also `llms-small.txt` and one file for each section. Every page also has a Markdown copy at its address with `.md` added. These come from the pages themselves, so nothing needs updating by hand.

## Pages a test follows

A test follows the quick start as a tester would: [Your first run](_site/src/content/docs/tutorials/first-run.md), [Hand the work to agents](_site/src/content/docs/tutorials/agents-with-a-free-model.md), and the command line and Check the machine sections of the install and troubleshooting pages. It runs their shell blocks as written, types the value each step gives a field (**Campaign name**: `matmul-agents`), presses the buttons they name in bold and checks the lines they quote. So in those pages:

- keep each step's commands in its own `sh` block, and mark a line for one container tool with `# Docker` or `# Podman`, or give the other tool's line after `# or:`;
- keep the steps numbered (`## 4. Sign in`): the test finds them by number;
- quote what the screen shows exactly, in a code span.

`node scripts/test.mjs src/testing/quick-start.test.ts` reads the pages as the test does, in a second. The whole test is `scripts/quick-start-acceptance.mjs`: see [the contributor guide](local-development.md#the-quick-start-test).

## When Thermite changes

A change to what Thermite does updates the pages that describe it in the same commit, written by whoever changes the code. That covers screens and their text, commands, settings, routes, events, errors and limits. Run `npm run docs:build` and `npm run docs:check` before that commit. Never leave pages for a later pass: a goal is not verified until its pages match the code. The [rules for every goal](plan/README.md#rules-for-every-goal) say so.
