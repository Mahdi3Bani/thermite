# Running Thermite locally

Thermite runs the same images under docker-compose, podman-compose and Kubernetes. Locally, one compose stack starts the control service and one unit (a harness and a supervisor), with the CPU target.

**Status:** this is the M1 stack. It stores contracts, records attempts, relays signed commands and reports events to control. The executor is a placeholder that times a probe; real measurement and judging arrive in M2.

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

The smoke test runs the whole M1 path end to end:

1. It builds a small demo repository and bundles it into the inbox.
2. It starts the stack.
3. It assigns a campaign through control with a signed command. The supervisor relays the command, and the harness imports the bundle and checks its commit.
4. It submits a patch as a proposer from inside the harness container.
5. It waits for the attempt's events to reach control, then stops the stack and removes its volumes.

```sh
COMPOSE="docker compose" npm run smoke:compose
COMPOSE="podman compose" npm run smoke:compose
COMPOSE="podman-compose" npm run smoke:compose
```

Set `KEEP=1` to leave the stack running afterwards.

## The command line

`thermite` validates contracts, prints campaign assignments, issues commands through control and submits patches:

```sh
node dist/cli/thermite.js contract validate examples/contracts/smoke-cpu.json
node dist/cli/thermite.js help
```

Inside the harness container the same tool is on the path as `thermite`.
