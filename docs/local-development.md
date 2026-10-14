# Running Thermite locally

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one unit (a harness and a supervisor), with the CPU target.

**Status:** the stack runs the judge on the CPU target. It builds candidates, gates and times them, and records verdicts, which reach control through the supervisor. Agents (M4) and the dashboard (M3) come later; a "proposer" here is you, submitting patches.

## Requirements

- Node.js 22.15 or later, for the checks and the command line.
- Docker with Compose, or Podman with `podman compose` or podman-compose.

## Checks

```sh
npm ci
npm run check            # typecheck, lint, tests, public-content check
```

## The compose stack

```sh
npm run dev:init         # writes local tokens to .dev/ (git-ignored)
npm run build
docker compose up -d --build     # or: podman compose up -d --build
```

- **control** listens on `127.0.0.1:8800`. It generates its command-signing key on first start and shares only the public key with the harness.
- **harness** has no published port. Only its supervisor reaches it, over the unit's internal network. It reads imports from `.dev/inbox` (read-only) and writes exports to `.dev/outbox`.
- **supervisor** polls the harness, sends new events to control and relays control's commands. The interval is `THERMITE_POLL_SECONDS` (60 by default).

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

Set `KEEP=1` to leave the stack running afterwards.

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

The default promotion policy waits for approval (`THERMITE_PROMOTION=owner_approval`); the acceptance test sets it to `auto` for its local stack.

## Agents

Workers and the planner run when the harness has a model route: an OpenAI-compatible endpoint given by `QWEN_BASE_URL` and `QWEN_MODEL`, with its key in `.dev/secrets/qwen-api-key` (git-ignored; `dev:init` writes a placeholder). Without a route, the judge still runs and you submit patches yourself.

`node scripts/agents-acceptance.mjs` checks the agent machinery without a real model: a scripted model on your machine plans one epoch and plays two workers, which edit, build, use the device and submit through the real harness image.

## The command line

`thermite` validates contracts, prints campaign assignments, issues commands through control and submits patches:

```sh
node dist/cli/thermite.js contract validate examples/contracts/smoke-cpu.json
node dist/cli/thermite.js help
```

Inside the harness container the same tool is on the path as `thermite`.
