---
title: "Contributing"
description: "How to work on Thermite itself, and the rules every change follows."
type: project
sidebar:
  order: 3
---

Thermite is open source under the [MIT license](https://github.com/iammrduncan/thermite/blob/main/LICENSE), and changes are welcome. This page shows how to set up a working copy, which checks a change must pass, and the rules every change keeps.

A full contributor guide, `CONTRIBUTING.md`, comes with [goal 008](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/008-community-files.goal), along with a code of conduct and issue and pull request templates. Until then, the repository's [AGENTS.md](https://github.com/iammrduncan/thermite/blob/main/AGENTS.md) and [CONVENTIONS.md](https://github.com/iammrduncan/thermite/blob/main/CONVENTIONS.md) hold the rules, and this page sums them up.

Before you start on a large change, say what you plan in a [GitHub issue](https://github.com/iammrduncan/thermite/issues) or on [Discord](https://discord.gg/3Qs2uejUf9), so that it fits the [roadmap](roadmap.md).

## Set up

You need Node.js 22.19 or later, git, and Docker or Podman.

```sh
git clone https://github.com/iammrduncan/thermite.git
cd thermite
npm ci
npm run check
```

`npm run check` runs every fast check. When it passes, your copy works. Thermite is written in TypeScript and runs on Node.js. To run Thermite itself from your copy, follow [Your first run](../tutorials/first-run.md).

## The checks

Run these from the repository root before each commit:

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | The TypeScript types |
| `npm run lint` | Style and common mistakes, with Biome. `npm run format` fixes what it can |
| `node scripts/test.mjs <files>` | The test files your change touches. `npm test` runs them all, one file at a time |
| `npm run check:public` | That no tracked or staged file holds private names (see below). Stage new files first, or run `node scripts/check-public.mjs --untracked` |

`npm run check` runs the typecheck, the lint, every test and the public check, in that order. One test keeps an example in step: after a change to `examples/smoke-project`, or to `kits/smoke-cpu` outside its candidates, `src/harness/smoke-check.test.ts` fails until `examples/contracts/smoke-cpu-goal.json` names their new commits, and says which field to set to which commit.

Changes to some parts also need a test that starts containers. Each takes from a few minutes to half an hour:

| When you change | Run |
| --- | --- |
| Containers, compose, the APIs or the relay | `COMPOSE="docker compose" npm run smoke:compose` |
| The judge, kits or the harness image | `COMPOSE="podman compose" npm run acceptance:judge` |
| Control, the dashboard, MCP or the relay | `COMPOSE="podman compose" node scripts/control-acceptance.mjs` |
| The workers, the planner or the scheduler | `COMPOSE="podman compose" node scripts/agents-acceptance.mjs` |
| The New campaign page, the campaign builder, a campaign's **Start a run**, kits kept on control, Git access or the supervisor's staging | `COMPOSE="podman compose" node scripts/campaign-acceptance.mjs` |
| Rigs on Kubernetes, including moving a rig onto new images, or control's image | `COMPOSE="podman compose" node scripts/cluster-acceptance.mjs` |

The campaign test serves a tiny project with `git daemon` and creates a campaign through the New campaign form, which starts a try of its kit. Then it starts the campaign's own run from the campaign's page, with the agents on. Its rig gets a model route that nothing answers, so the agents fail at once, and the script submits the changes itself. The cluster test sets rigs up on a local kind cluster, in a namespace control creates and in a pre-made slot. Then it restarts control with re-tagged images, moves the slot's rig onto them with **Update to these images**, and checks that the rig reports again from the new pods with its volume claim and secret unchanged.

[AGENTS.md](https://github.com/iammrduncan/thermite/blob/main/AGENTS.md#checks) lists every acceptance test and when it is needed. These tests use local stand-ins only: a scripted model, a container with an SSH server, a local Kubernetes cluster in containers. They never touch a real host or cluster. The scripts clean up when their stack comes down. After a run that you stopped by hand, remove dangling images (`docker image prune -f` or `podman image prune -f`) and, with Podman on a Mac, trim its virtual machine's disk (`podman machine ssh sudo fstrim -a`). Never prune tagged images: they may belong to other projects.

## What CI runs

Continuous integration (`.github/workflows/ci.yml`) runs on every pull request, and on every push to `main` and to the development branch, `v1/build`. It has these jobs:

| Job | What it runs |
| --- | --- |
| **checks (Node 22)**, **checks (Node 24)** | `npm ci`, the typecheck, the lint, every test and the public check, on each Node.js version |
| **docs site** | `npm run docs:build` and `npm run docs:check` |
| **secret scan** | gitleaks over the whole history of the commit (see below) |
| **compose-smoke** | The compose smoke test with Docker, after both **checks** jobs pass |

A new commit on a pull request cancels the run for the commit before it. Every push to `main` or `v1/build` gets a whole run of its own.

`.github/dependabot.yml` asks Dependabot for updates once a week: Thermite's packages, this site's packages and the GitHub Actions in the workflow. For each of the three, the minor and patch updates come together in one pull request. A major update comes alone, and so does every Starlight update, because Starlight is still 0.x.

### The secret scan

The **secret scan** job runs [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 with its default rules over every commit in the history, not only the last one. CI downloads that release and checks it against the SHA-256 from the release's checksums file before it runs it. When the scan finds something, it prints the file, the commit and the rule with the value hidden, and the job fails.

Some tests use made-up values in the shape of a key, such as a fake RunPod key. [`.gitleaks.toml`](https://github.com/iammrduncan/thermite/blob/main/.gitleaks.toml) names each one by its rule, its file and its exact value, and the scan skips only those. When a test needs a new made-up key, add an entry for that file and that value, never a wider pattern.

To run the same scan on your copy, run this from the root of your clone. With Docker, write `docker` in place of `podman`.

```sh
podman run --rm -v "$PWD":/repo:ro ghcr.io/gitleaks/gitleaks:v8.30.1 \
  git /repo --config /repo/.gitleaks.toml --redact --log-opts="--full-history HEAD"
```

It ends with `no leaks found` when the history is clean.

## Work on the dashboard

To work on the dashboard without a stack, run the dashboard demo. It serves made-up campaigns and rigs, and prints the token to sign in with:

```sh
node --experimental-strip-types scripts/dashboard-demo.ts   # http://127.0.0.1:8810/ui
```

One of the demo's runs has a made-up experiment queue: experiments tried, in progress and up next, a lane's idea and a hand-out. The same run has made-up field notes on its **Journal** tab, and the **Knowledge** page shows the demo campaigns' folders. The demo has no campaign saved on control or assigned through it and no owner's messages, so it shows no **Start a run** and no kept messages. The dashboard's tests cover those. This site's screenshots come from the demo, because its data is made up: with the demo running, `node scripts/docs-screenshots.mjs` takes them again, the run's **Journal** tab and the **Knowledge** page among them. [Running Thermite locally](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md) has more for contributors.

## Keep the repository public-safe

The repository is public, and so are its commit messages. Tracked files and commit messages must never hold:

- machine, host or cluster names;
- IP or MAC addresses, or internal domains;
- account, vault or secret names, secret values or paths to secrets;
- private repository paths;
- descriptions of security gaps or access maps of a deployment.

Examples use made-up names, such as `gpu-host-1`, `rig-1` and `control.example.com`. `npm run check:public` finds most slips in files, but it does not read commit messages: check those yourself.

## The design rules

Every change keeps these rules. [CONVENTIONS.md](https://github.com/iammrduncan/thermite/blob/main/CONVENTIONS.md) gives each one in full.

1. **Agents propose; code judges.** Nothing an agent can write reaches measurements, verdicts, completion or promotion. [Why agents never judge](../explanation/why-agents-never-judge.md) explains why.
2. **The harness owns the state.** Every agent call starts fresh, from context the harness builds from its records.
3. **Nothing is destroyed.** Every candidate's code is kept before it is built or measured. A correction is a new record.
4. **Lifecycle and verdict are separate.** An infrastructure failure never counts as a research loss.
5. **Nothing stops silently.** Budgets are explicit, a pause records its reason, and the harness, never an agent, decides by the campaign mode's rule when a campaign is complete.
6. **Objectives are versioned contracts.** A changed objective is a new contract version.
7. **Control's commands are signed,** and imports are accepted only when their hashes match.
8. **Targets go through drivers.** Never assume a GPU, one provider or one model.
9. **Steering is traceable.** Every directive and command records who issued it and why.

The code is TypeScript in strict mode. Every input that crosses a trust boundary is checked against a schema: API requests, contracts, commands, imported files and all model output. Tests check behaviour that can fail, including the failure cases.

## Change the docs

This site is built from `docs/_site/` in the repository. [Writing Thermite's documentation](https://github.com/iammrduncan/thermite/blob/main/docs/writing-docs.md) says how a page is written, linked and checked. To preview and check the site:

```sh
npm run docs:install   # once
npm run docs:dev       # a live preview
npm run docs:build
npm run docs:check
```

A change to what Thermite does also updates the pages that describe it, in the same commit: screens and their text, commands, settings, routes, events, errors and limits. Run `npm run docs:build` and `npm run docs:check` before you commit.

## Plans and ideas

Every planned change is a goal in [docs/plan/](https://github.com/iammrduncan/thermite/blob/main/docs/plan/README.md). That page says how goals are written and how an idea becomes one. A change that settles a design question records the decision in its goal.
