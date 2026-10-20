---
title: "Contributing"
description: "How to work on Thermite itself, and the rules every change follows."
type: project
sidebar:
  order: 3
---

Thermite is open source under the [MIT license](https://github.com/iammrduncan/thermite/blob/main/LICENSE), and changes are welcome. This page shows how to send a change, how to set up a working copy, which checks a change must pass, and the rules every change keeps.

The repository holds the rules, and this page sums them up:

| File | What it holds |
| --- | --- |
| [CONTRIBUTING.md](https://github.com/iammrduncan/thermite/blob/main/CONTRIBUTING.md) | The essentials: the terms, how to send a change, and the checks |
| [The contributor guide](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md) | Every check, the compose stack you develop against, the dashboard demo and each acceptance test |
| [CONVENTIONS.md](https://github.com/iammrduncan/thermite/blob/main/CONVENTIONS.md) | The design rules that every change keeps, and the rules for code and tests |
| [AGENTS.md](https://github.com/iammrduncan/thermite/blob/main/AGENTS.md) | The same rules, written for a coding agent that works on the repository |
| [CODE_OF_CONDUCT.md](https://github.com/iammrduncan/thermite/blob/main/CODE_OF_CONDUCT.md) | The code of conduct: the Contributor Covenant 2.1 |
| [SECURITY.md](https://github.com/iammrduncan/thermite/blob/main/SECURITY.md) | How to report a security problem privately |

There is no contributor agreement to sign and no sign-off line to add to your commits. What you contribute is published under the project's MIT license.

Before you start on a large change, say what you plan in a [GitHub issue](https://github.com/iammrduncan/thermite/issues) or on [Discord](https://discord.gg/3Qs2uejUf9), so that it fits the [roadmap](roadmap.md).

## Send a change

1. Fork the repository on GitHub, and make a branch in your fork.
2. Make the change in small commits, each with a clear message that says what it does.
3. Run the checks below.
4. Open a pull request. Its form asks what the change does and why, which checks you ran, and which pages you changed.

A new screen, or a real change to one, needs a mockup that the maintainers agreed to first: open an issue with it before you build the screen.

## Set up

You need Node.js 22.19 or later, git, and Docker or Podman.

```sh
git clone https://github.com/iammrduncan/thermite.git
cd thermite
npm ci
npm run check
```

`npm run check` runs every fast check. When it passes, your copy works. Thermite is written in TypeScript and runs on Node.js. To run Thermite itself from your copy, build its images with the repository's own `compose.yaml`: `npm run dev:init`, then `docker compose up -d --build`. The [contributor guide](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md#the-compose-stack-built-from-source) says more. [Your first run](../tutorials/first-run.md) runs a release's published images instead.

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
| The workers, the planner, the scheduler, or the OpenCode harness in a hill-climb or research trial | `COMPOSE="podman compose" node scripts/agents-acceptance.mjs` |
| The New campaign page, the campaign builder, a campaign's **Start a run**, kits kept on control, Git access or the supervisor's staging | `COMPOSE="podman compose" node scripts/campaign-acceptance.mjs` |
| Rigs on Kubernetes, including moving a rig onto new images, or control's image | `COMPOSE="podman compose" node scripts/cluster-acceptance.mjs` |
| The one-container rig image, the broker's start of the supervisor, its wait for enrollment or the isolation selftest | `COMPOSE="podman compose" node scripts/rig-image-acceptance.mjs` |
| Rigs on RunPod: their launch, stop, start, restart and terminate, or the fake RunPod API | `COMPOSE="podman compose" node scripts/runpod-acceptance.mjs` |
| The quick start's pages, the images or compose, the release bundle, or the sample in `examples/` | `COMPOSE="podman compose" node scripts/quick-start-acceptance.mjs` |

The quick-start test follows [Your first run](../tutorials/first-run.md) and [Hand the work to agents](../tutorials/agents-with-a-free-model.md) as a tester does. It builds the images from your copy and writes a release bundle for them with `scripts/release-bundle.ts`. Then it runs each shell block of the pages as they are written, in a new folder, and uses the values, buttons and words the pages give: `src/testing/quick-start.ts` reads them. It changes only what cannot work before a release is published: the release's files and the source come from servers on your computer, and the agents' model is the scripted model of the agents test. It runs the rig's checks and `thermite doctor`, then the sample campaign to the judge's first verdict. It takes about 7 minutes when the images' layers are already built, and about 20 when they are not. When you change one of those pages, run `node scripts/test.mjs src/testing/quick-start.test.ts`: it fails at once when a page no longer has what the test reads.

The campaign test serves a tiny project with `git daemon` and creates a campaign through the New campaign form, which starts a try of its kit. Then it starts the campaign's own run from the campaign's page, with the agents on. Its rig gets a model route that nothing answers, so the agents fail at once, and the script submits the changes itself. The cluster test sets rigs up on a local kind cluster, in a namespace control creates and in a pre-made slot. Then it restarts control with re-tagged images, moves the slot's rig onto them with **Update to these images**, and checks that the rig reports again from the new pods with its volume claim and secret unchanged. The RunPod test runs control in the script against a fake RunPod API (`src/testing/fake-runpod.ts`, which the unit tests use too) that answers no other host: each pod it makes is a container of the rig image on a volume, reached through a stand-in for RunPod's proxy. It never calls RunPod and spends nothing.

One test is run by hand only, with the owner's OK, because it spends money: `scripts/runpod-paid-acceptance.mjs` launches one real pod through a real control, with a spend limit you give, and checks it from launch to terminate.

[AGENTS.md](https://github.com/iammrduncan/thermite/blob/main/AGENTS.md#checks) lists every acceptance test and when it is needed. These tests use local stand-ins only: a scripted model, a container with an SSH server, a local Kubernetes cluster in containers. They never touch a real host or cluster. The scripts clean up when their stack comes down. After a run that you stopped by hand, remove dangling images (`docker image prune -f` or `podman image prune -f`) and, with Podman on a Mac, trim its virtual machine's disk (`podman machine ssh sudo fstrim -a`). Never prune tagged images: they may belong to other projects.

## What CI runs

Continuous integration (`.github/workflows/ci.yml`) runs on every pull request, and on every push to `main` and to the development branch, `v1/build`. It has these jobs, and runs **quick-start** on a pull request only when the change can affect the quick start:

| Job | What it runs |
| --- | --- |
| **checks (Node 22)**, **checks (Node 24)** | `npm ci`, the typecheck, the lint, every test and the public check, on each Node.js version |
| **docs site** | `npm run docs:build` and `npm run docs:check` |
| **secret scan** | gitleaks over the whole history of the commit (see below) |
| **compose-smoke** | The compose smoke test with Docker, after both **checks** jobs pass |
| **rig image** | Builds the one-container rig image, enrolls it in pull mode from control's code in the script, and runs its isolation self-test with Docker (`scripts/rig-image-acceptance.mjs`) |
| **runpod** | Launches a rig on the fake RunPod API, whose pod is a container of the rig image, then stops, starts and terminates it, with Docker (`scripts/runpod-acceptance.mjs`) |
| **quick start, needed?** | Decides whether **quick-start** runs: always on a push, and on a pull request only when it changes the containers, a compose file, the release bundle, the quick start's pages, `examples/`, the smoke kit or the test itself |
| **quick-start** | The quick-start test with Docker (`scripts/quick-start-acceptance.mjs`), after both **checks** jobs pass. It stops after 60 minutes. Its report, with each check and how long each step took, is the run's artifact `quick-start-report` |

A new commit on a pull request cancels the run for the commit before it. Every push to `main` or `v1/build` gets a whole run of its own.

A second workflow, `.github/workflows/release.yml`, runs on a tag that starts with `v`. It builds the control, harness (CPU and CUDA) and supervisor images, and the one-container rig image for RunPod on the CUDA harness, pushes them to `ghcr.io`, and attaches the release bundle (`compose.yaml` and `README.md`, made by `scripts/release-bundle.ts`) to a draft GitHub Release. Run by hand from the **Actions** tab, it builds the same images and bundle but pushes nothing. The [contributor guide](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md#releases) describes each step.

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

One of the demo's runs has a made-up experiment queue: experiments tried, in progress and up next, a lane's idea and a hand-out. The same run has made-up field notes on its **Journal** tab, and the **Knowledge** page shows the demo campaigns' folders. The demo has no campaign saved on control or assigned through it and no owner's messages, so it shows no **Start a run** and no kept messages. The dashboard's tests cover those. This site's screenshots come from the demo, because its data is made up: with the demo running, `node scripts/docs-screenshots.mjs` takes them again, the run's **Journal** tab and the **Knowledge** page among them. [The contributor guide](https://github.com/iammrduncan/thermite/blob/main/docs/local-development.md) has more.

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
