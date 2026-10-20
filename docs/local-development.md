# Contributor guide: running Thermite locally

This is the guide for people working on Thermite itself: the checks, the compose stack you develop against, the dashboard demo and the acceptance tests. [CONTRIBUTING.md](../CONTRIBUTING.md) has the essentials: the terms, how to send a change and the rules every change keeps. [CONVENTIONS.md](../CONVENTIONS.md) has the design rules that every review checks. To **use** Thermite, start with the documentation site: [Your first run](_site/src/content/docs/tutorials/first-run.md), then the [how-to guides](_site/src/content/docs/how-to/install/one-machine.md).

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one rig (a harness and a supervisor), with the CPU target.

## Requirements

- Node.js 22.19 or later, for the checks and the command line (the agent libraries require it).
- Docker with Compose, or Podman with `podman compose` or podman-compose.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check
```

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main` and to the development branch, `v1/build`. It runs the same checks on Node 22 and 24, builds and checks the documentation site, scans the whole history for secrets with gitleaks (the allowlists for made-up keys are in `.gitleaks.toml`), then runs the compose smoke test with Docker. On pushes, and on pull requests that touch the containers, compose, the release bundle, the quick start's pages or the sample, it also runs [the quick-start test](#the-quick-start-test). [What CI runs](_site/src/content/docs/project/contributing.md#what-ci-runs) describes each job, and [AGENTS.md](../AGENTS.md#checks) lists every check and when each one is needed.

The documentation site has its own build and checks: see [Writing the documentation](writing-docs.md).

## The compose stack, built from source

Users install Thermite from a release: its `compose.yaml` runs the published images, and nothing is built ([Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md)). To work on Thermite, build the images from your clone instead. The repository's own `compose.yaml` does that:

```sh
git clone https://github.com/iammrduncan/thermite.git
cd thermite
npm ci
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build            # the command line on your computer: npx thermite
docker compose up -d --build     # or: podman compose up -d --build
```

- `npm run dev:init` needs only Node.js, not `npm ci`. It writes the same `.dev/` folder as a release's `init` service (`thermite local init`), and keeps every file that exists. A unit test (`src/cli/local-init.test.ts`) checks that both make the same files and modes.
- The first build takes 20 minutes or more; later starts take seconds. After `git pull`, run `npm run dev:init` and `docker compose up -d --build` again.
- `THERMITE_COMMIT=$(git rev-parse HEAD) docker compose build` gives the images their commit, which each service reports.
- With Claude Code in the images (`compose.claude.yaml`, from [Use a Claude subscription](_site/src/content/docs/how-to/models/claude-subscription.md)), name that file in every `up --build`.

The stack, its settings and how to operate it are described on the site:

- what each container is, its volumes and how to keep it running: [Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md);
- every setting: [Settings](_site/src/content/docs/reference/settings.md);
- models, advisors, the results repository, keys, tokens, restarts and resets: the [how-to guides](_site/src/content/docs/how-to/operate/check-a-rig.md);
- MCP and the REST API: [Let an agent run Thermite over MCP](_site/src/content/docs/how-to/automate/agent-over-mcp.md) and [Script Thermite with the REST API](_site/src/content/docs/how-to/automate/rest-api.md);
- the command line: [Command line](_site/src/content/docs/reference/command-line.md).

The `two-rigs` profile adds a second rig (`local-2`), which the control and steering acceptance tests use. `compose.lifecycle.yaml` lets control restart containers through the engine's socket; it is for development only.

`compose.yaml` passes the optional settings through from your shell or `.env`, each with its default. That includes the knowledge base's two timers: `THERMITE_KB_SYNC_SECONDS` for both rigs' supervisors (180), and `THERMITE_OUTSIDE_KB_SYNC_SECONDS` for control (300). Set one lower to see past research or an outside copy move sooner, or to `0` to turn that timer off; **Sync now** still copies a folder by hand.

## The dashboard demo

To work on the dashboard without a stack, run a demo with synthetic campaigns and rigs:

```sh
node --experimental-strip-types scripts/dashboard-demo.ts   # http://127.0.0.1:8810/ui
```

It prints the token to sign in with. One of its runs has a made-up experiment queue: experiments tried, in progress and up next, a lane's idea and a hand-out. The same run has five made-up field notes on its **Journal** tab, from lane-1, lane-2, the planner, the auditor and a teacher, and the **Knowledge** page shows a folder for each of the demo's campaigns, built from their events. The demo has no campaign saved on control or assigned through it and no owner's messages, so it shows no **Start a run** and no kept messages; the dashboard's tests cover those. One of them (`src/control/dashboard.test.ts`) also drives the **Experiments** and **Planner** tabs through a real harness: it adds, moves and drops experiments, and adds and removes a rule in free words. The dashboard's tests use a smaller fixture with the shapes the harness writes (`src/testing/control-demo.ts`): a goal campaign with attempts held for audits, a run at work, and a hill climb with an approval and an auditor's block, field notes and a research note.

The documentation's screenshots come from the demo, whose data is made up. With the demo running, `node scripts/docs-screenshots.mjs` takes them again: the Overview, the Campaigns list, a run's page, the run's **Experiments** and **Journal** tabs, Live for a run at work, the **Knowledge** page and a rig's page, at 1440×900 in the light theme, as WebP files in `docs/_site/src/assets/screenshots/`. It needs a local Chrome or Chromium (`--chrome PATH`); `--out DIR` writes the files elsewhere, to look at them first.

## Journals and the knowledge base

Goal 065's parts are covered by unit tests, which `npm test` runs like any other: field notes (`src/harness/journal.test.ts`, `src/harness/agents/scheduler-notes.test.ts`), research in every mode (`src/harness/research/research-everywhere.test.ts`), the export (`src/harness/export-notes.test.ts`), the supervisor's past-research sync (`src/supervisor/kb-sync.test.ts`), the advisors' notes (`src/supervisor/advise-notes.test.ts`), control's knowledge base and its pages (`src/control/kb.test.ts`, `src/control/kb-ui.test.ts`) and outside knowledge bases (`src/control/outside-kb.test.ts`, `src/supervisor/advise-outside-kb.test.ts`).

- **A fake outside knowledge base** (`src/testing/fake-kb.ts`) stands in for a GBrain-style brain: an MCP server on a free local port that takes one bearer token, with a search tool and a page-writing tool shaped like GBrain's `put_page`. It keeps every page, call and request, so a test can look at what control and the supervisor sent. A test can make it refuse every page (`failWrites`), or only the pages whose slug holds some words (`failPage`), as a server does that refuses one page for good.
- **Control's assignments** (`src/testing/assignments.ts`): control serves a rig's past research and outside knowledge bases only for runs it assigned, so a test that seeds a rig's events records control's own assignment of the run with `assigned(store, rig, run, campaign)`.

No compose acceptance test covers them yet.

## The smoke test

The smoke test runs the whole path once, end to end:

1. It bundles the smoke project and its kit into the inbox.
2. It starts the stack.
3. It assigns a campaign through control with a signed command. The supervisor relays the command, and the harness imports both bundles and checks their commits and hashes.
4. It submits one candidate as a proposer from inside the harness container.
5. It waits until the judge's verdict reaches control, then stops the stack and removes its volumes.

```sh
COMPOSE="docker compose" npm run smoke:compose
COMPOSE="podman compose" npm run smoke:compose
COMPOSE="podman-compose" npm run smoke:compose
```

Set `KEEP=1` to leave the stack running afterwards. To run it beside another stack, give it its own project and control port: `THERMITE_PROJECT=thermite-smoke THERMITE_CONTROL_PORT=8801`.

### The smoke project's commits

A rig's smoke check (one of its [rig checks](_site/src/content/docs/how-to/operate/check-a-rig.md)) makes git repositories from `examples/smoke-project` and `kits/smoke-cpu` (without its candidates). The same files always give the same commits, and `examples/contracts/smoke-cpu-goal.json`, the contract of the [goal-campaign tutorial](_site/src/content/docs/tutorials/first-goal-campaign.md), names them. So a change to either folder changes the commits the contract must name. A unit test in `src/harness/smoke-check.test.ts` makes the repositories as the smoke check does and compares: when it fails, it says which field of the contract to set to which commit.

`examples/matmul-cpu` is the sample project of the [agents tutorial](_site/src/content/docs/tutorials/agents-with-a-free-model.md): a copy of the same project (`project/`) and kit (`kit/`, named `matmul-cpu`, without candidates), kept apart so that the smoke check's commits don't move when the sample changes. A fix to the project or the kit usually belongs in both. The new-campaign page test uploads the sample's kit as the tutorial packs it, and the new-campaign acceptance runs a try of it from its folder.

## The judge acceptance test

`npm run acceptance:judge` runs the smoke campaign (`kits/smoke-cpu`, `examples/smoke-project`) through the whole judge under compose. It submits every candidate in `kits/smoke-cpu/candidates`, each with an expected outcome:

| Candidate | Expected |
| --- | --- |
| A faster kernel | screened, confirmed on fresh data, promoted |
| The same kernel, restated | neutral |
| Wrong results, a build error, NaN output | invalid |
| A timer in the kernel, an edit to the reference | refused before building (static checks) |
| A call to the reference implementation | invalid: the dispatch probe shows the reference ran |
| Too much memory, a full disk | crash_candidate: killed at the run's limits |
| An attempt to overwrite the champion's binary | judged normally; the build store is unchanged |
| A process left running after the benchmark | judged normally; nothing of the run survives it |

It also checks that every role user is refused access to the ledger, kits, builds, secrets and the broker; that a killed controller is recorded as one infrastructure failure and the job still completes; and that the A/A noise of the machine is measured. The report goes to `.dev/acceptance/`.

```sh
COMPOSE="podman compose" npm run acceptance:judge
```

## Agents without a model

`node scripts/agents-acceptance.mjs` checks the agent machinery without a real model: a scripted model on your machine plans one round and plays two workers, which edit, build, use the device and submit through the real harness image. Then the rig's agents move to OpenCode: a hill-climb trial submits with `thermite-trial`, and a research run's trial runs the research tools as `thermite-trial research` commands. Its fetch names your machine, so the harness's fetcher must refuse it as a private address; its note, report section and progress must come back from the harness.

## A long research run

`node scripts/research-longrun.mjs` runs a research campaign for a set time (`MINUTES`, 125 by default) with a scripted worker.

- It reads real public pages, at about one page every two minutes, with robots.txt respected.
- It records quote-verified claims, and kills the harness controller once halfway.
- It checks that the campaign closes on its clock with digests, verified claims and a final report.
- This tests the machinery only; research quality needs a real model.

## The steering acceptance test

`node scripts/steering-acceptance.mjs` runs two rigs with a scripted model on your machine. It checks:

- directives from the teacher pair and their attribution in the next round;
- an audit block holding a confirmed win, and a cleared audit letting the next one promote;
- propagation of a champion to the second rig, judged there and shown cross-verified;
- the supervisor's limits (it cannot submit, and it cannot forge a command);
- daily reports;
- a restart, when an engine socket is available;
- a full reset.

## The quick-start test

`node scripts/quick-start-acceptance.mjs` follows the quick start as a tester does: [Your first run](_site/src/content/docs/tutorials/first-run.md), then [Hand the work to agents](_site/src/content/docs/tutorials/agents-with-a-free-model.md) to the judge's first verdict on the sample in `examples/matmul-cpu`.

1. **The release, from your copy.** It builds the control, harness and supervisor images, and writes the release bundle for them with `scripts/release-bundle.ts`, pinned by digest. With Podman the images stay in local storage. With Docker they go to a registry container on `127.0.0.1`, so that each one has a digest. The CUDA harness is not built: the bundle names the CPU harness in its place, and no step uses it.
2. **The pages' own steps.** `src/testing/quick-start.ts` reads the tutorials, the command line section of [Install Thermite on one machine](_site/src/content/docs/how-to/install/one-machine.md#the-command-line) and [Check the machine](_site/src/content/docs/how-to/operate/troubleshoot.md#check-the-machine). The test runs each shell block as written, in a new folder, with the line for your container tool. It types the values the pages give, presses the buttons they name, and checks the words they quote: the init's last line, Overview's first line, the smoke check's result and its verdict counts, the model check, the kit's summary, the campaign's start and its pause.
3. **Only what cannot work before a release.** The release's files come from a small server on your computer, and the source from your copy's tracked files, committed and tagged as the release and served by `git daemon`. The agents' model is the scripted model of the agents test (`scripts/lib/scripted-model.mjs`), added as an OpenAI-compatible provider, under OpenCode v2 as the page says. **Look it up** reads only `https://` addresses, so the test looks the tag up itself. The doctor checks the scripted model's address. When a page no longer has what one of these changes is for, the test fails.

It needs port 8800 free and no volumes of a compose project named `thermite`: it stops before it builds anything otherwise. It removes its stack, its volumes, its images, dangling images and its folder at the end, and writes a report to `.dev/acceptance/`. `KEEP=1` leaves the stack and the folder.

```sh
COMPOSE="podman compose" node scripts/quick-start-acceptance.mjs
```

A change to the steps of those pages runs this test in CI. Run `node scripts/test.mjs src/testing/quick-start.test.ts` first: it reads the pages as the test does, and fails at once when a step, a value or a quoted line it needs has gone.

## Other acceptance tests

[AGENTS.md](../AGENTS.md#checks) lists the rest, each with when it is needed: control (two rigs), new campaign, machines over SSH, clusters on kind, rig deploy, multi-GPU and Claude Code. Each uses local stand-ins, never a real host or cluster. Two of them check more than their names say:

- **New campaign** (`scripts/campaign-acceptance.mjs`) creates a campaign through the New campaign form, which starts a try of its kit, then starts the campaign's own run from the campaign's page (**Start a run**) with the agents on. The rig gets a model route that nothing answers (`THERMITE_MODEL_BASE_URL=http://127.0.0.1:9/v1`), so control lets the agents start and they fail at once; the script submits the changes itself.
- **Clusters on kind** (`scripts/cluster-acceptance.mjs`) keeps control's records on a Podman volume. After the slot's rig reports, it tags both rig images `:accept-update`, loads them into kind and restarts control with them. Then it checks that the rig's page offers **Update to these images**, that the rig's new pods run those images and report again, and that its volume claim and secret are unchanged. The update is tried on the slot's CPU rig only.

## Releases

A release is made from a tag. `.github/workflows/release.yml` runs on every tag that starts with `v`:

1. **Version.** It takes the version from the tag (`v0.1.0` gives `0.1.0`) and stops unless it is `package.json`'s version, or a pre-release of it such as `0.1.0-rc.1`.
2. **Images.** It builds four images from their Containerfiles and pushes them to `ghcr.io/<owner>/`: `thermite-control`, `thermite-harness` (CPU) and `thermite-supervisor` for amd64 and arm64 (arm64 under QEMU), and the CUDA harness for amd64, in the `thermite-harness` package with tags that end in `-cuda`. Its base, `nvidia/cuda:12.6.3-devel-ubuntu22.04`, is pinned by digest in the workflow. Each image is tagged with the version and the commit's first 12 characters, and labelled with the source repository, the version and the commit. Every build gets `THERMITE_COMMIT`, and the harness builds `THERMITE_IMAGE_ID`. No build sets `CLAUDE_CODE_VERSION`.
3. **Bundle.** `scripts/release-bundle.ts` fills in `containers/release/compose.template.yaml` and `containers/release/README.template.md` with the images' digests, and the workflow attaches `compose.yaml` and `README.md` to a **draft** GitHub Release. A maintainer reads the draft and publishes it.

The template is the repository's `compose.yaml` with `image:` lines in place of `build:` lines, this release's images as control's rig image defaults, and an `init` service that runs `thermite local init`. `src/release/bundle.test.ts` fails when the two drift apart, and the script refuses to write a bundle from a template that has drifted: a change to `compose.yaml`'s services goes into the template in the same commit.

To test the workflow without a tag, run it by hand: **Actions › release › Run workflow**. It builds every image and the bundle, pushes nothing and makes no release, and keeps the bundle as the run's artifact `release-bundle`. To make a bundle on your computer from digests you have:

```sh
mkdir -p digests   # one file per image: control, harness, harness-cuda, supervisor, each with sha256:…
node --experimental-strip-types scripts/release-bundle.ts --version 0.1.0 \
  --registry ghcr.io/iammrduncan --repo-url https://github.com/iammrduncan/thermite \
  --digests digests --out bundle
```

New GHCR packages start private. After the first release, a maintainer makes each package public in its settings, so that rigs and testers can pull it without signing in.

## Clean up

The compose scripts prune dangling images and trim the Podman VM when their stack comes down. After a run stopped by hand, do the same: `podman image prune -f`, then `podman machine ssh sudo fstrim -a`. Never prune tagged images, which may be other projects'.
