# Writing Thermite's documentation

Thermite's documentation is a website built with [Astro Starlight](https://starlight.astro.build/) from `docs/_site/`. This page says how the site is put together, how to write a page, and how to check it. The plans in [plan/](plan/README.md) and this folder's other files are repository documents, not part of the site.

## Build and check

```sh
npm run docs:install   # once: the site's own dependencies, from docs/_site/package-lock.json
npm run docs:dev       # a live preview at http://localhost:4321/thermite/
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
- a placeholder in angle brackets, such as `<campaign>`, outside a code span: the site reads it as an HTML tag and hides it, so write it in backticks;
- a page missing from `llms.txt` or `llms-full.txt`, or without its Markdown copy;
- a page that is still a stub.

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

## When Thermite changes

A change to what Thermite does updates the pages that describe it in the same commit, written by whoever changes the code. That covers screens and their text, commands, settings, routes, events, errors and limits. Run `npm run docs:build` and `npm run docs:check` before that commit. Never leave pages for a later pass: a goal is not verified until its pages match the code. The [rules for every goal](plan/README.md#rules-for-every-goal) say so.
