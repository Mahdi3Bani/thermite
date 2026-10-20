---
title: "Harness image"
description: "What the harness, supervisor and control images and the one-container rig image contain: base images, toolchains, users and groups, paths and build arguments."
type: reference
sidebar:
  order: 13
---

Thermite runs as three container images. The **harness** image holds a rig's judge, broker and agents; the **supervisor** image is the rig's link to the outside; the **control** image is the central service. A fourth, the **one-container rig image**, puts a rig's harness and supervisor in one container, for hosts that run one container per machine, such as RunPod. This page lists what each one contains. [Extend the harness image](../how-to/install/extend-harness-image.md) adds your project's tools, and [Push the images to your own registry](../how-to/install/own-registry.md) builds them. The [glossary](glossary.md) explains the terms.

Each image is built from the repository's root, from its own file:

| Image | Built from |
| --- | --- |
| Harness | `containers/harness/Containerfile` |
| Supervisor | `containers/supervisor/Containerfile` |
| Control | `containers/control/Containerfile` |
| One-container rig | `containers/rig/Containerfile`, on a harness image built first |

```sh
docker build -t thermite-harness -f containers/harness/Containerfile .
```

`podman build` takes the same arguments. Under compose, `docker compose build` builds all three. No image is published yet: [goal 010](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/010-published-images.goal) plans that.

## Build arguments

| Argument | Images | Default | Effect |
| --- | --- | --- | --- |
| `NODE_IMAGE` | All three | `docker.io/library/node:22-bookworm-slim`, pinned by its sha256 digest | The Node.js image every stage starts from |
| `BASE_IMAGE` | Harness | `NODE_IMAGE` | The harness's final base. GPU rigs set a CUDA 12.x development image: see [The CUDA harness](#the-cuda-harness) |
| `OPENCODE_VERSION` | Harness | `2.0.32` | The OpenCode release installed |
| `CLAUDE_CODE_VERSION` | Harness, supervisor | empty | A Claude Code release to install. Empty: Claude Code is not installed |
| `KUBECTL_VERSION` | Control | `v1.37.1` | The kubectl release installed. Its sha256 is pinned for amd64 and arm64 only |
| `HARNESS_IMAGE` | One-container rig | none: required | The harness image the rig image is built on. See [The one-container rig image](#the-one-container-rig-image) |
| `TARGETARCH` | All three | set by the builder | Chooses the arm64 or x64 package of OpenCode, Claude Code and kubectl |

## The harness image

### What it contains

| Part | Version | Where |
| --- | --- | --- |
| Node.js | The one in `NODE_IMAGE` (Node.js 22) | `/usr/local/bin/node`, copied from `NODE_IMAGE`. On another `BASE_IMAGE` only this binary is copied, without npm |
| Thermite | This repository's build, with its production dependencies | `/opt/thermite` (`dist/`, `node_modules/`, `package.json`) |
| `thermite` command | Thermite's command line | `/usr/local/bin/thermite`. See [Command line](command-line.md) |
| `thermite-trial` | The tools an agent uses from its own shell under OpenCode or Claude Code: `submit`, `dev-run`, `status`, `idea` and `note` (a [field note](knowledge-base.md#field-notes)), and the `research` commands: all ten for a research worker under OpenCode, and `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note` in a hill-climb or goal trial. See [Command line](command-line.md#thermite-trial) | `/usr/local/bin/thermite-trial` |
| OpenCode | `OPENCODE_VERSION`, 2.0.32 by default. Always installed. One of the [worker harnesses](glossary.md); Pi, the default one, is a library built into Thermite. Pi gives its workers Thermite's tools directly: in a code trial `note`, `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note` beside its others, and in a research trial `note` beside the research tools | `/usr/local/bin/opencode` |
| Claude Code | `CLAUDE_CODE_VERSION`. Installed only when that argument names a version | `/usr/local/bin/claude` |
| `thermite-devfence` | Built from `containers/harness/devfence.c` | `/usr/local/bin/thermite-devfence`. The GPU fence: it starts each role's command with the GPU device nodes it may not open left out, using the kernel's Landlock |
| C and C++ toolchain | From the base image's apt repository; not pinned | `gcc`, `g++`, `libc6-dev`, `make`, `cmake`, `ninja-build`, `ccache` |
| Python | From the base's apt repository; not pinned | `python3`, `python3-numpy` |
| Other packages | From the base's apt repository; not pinned | `git`, `tini`, `ca-certificates`. The build fails unless `setpriv`, `prlimit` and `taskset` exist |
| Smoke kits and projects | This repository's `kits/` and `examples/` | `/opt/thermite/checks/kits`, `/opt/thermite/checks/examples`. The [smoke check](rig-checks.md#smoke-check) uses them |

On the default base, the apt packages are Debian 12 ("bookworm") packages. The base must use apt (Debian or Ubuntu), because the image installs its packages with `apt-get`.

### The CUDA harness

GPU rigs need the same image built on a CUDA 12.x development image, with `--build-arg BASE_IMAGE=<image>`. The image's comment says why 12.x: CUDA 13 dropped older GPU architectures. A development image is needed because the CUDA smoke kit builds with `nvcc`. The repository names no exact CUDA image tag. RunPod test pods ask for hosts with CUDA 12.6 or later.

The CPU image has no `nvcc`, so it cannot build GPU kits. Control finds the CUDA image through `THERMITE_RIG_HARNESS_CUDA_IMAGE` (rigs it sets up, and the image it moves a cluster rig with GPUs onto) and `THERMITE_RUNPOD_TEST_IMAGE` (test pods). Compose runs CPU rigs only.

### Users and groups

The broker runs each kind of work as its own user. The numbers are fixed in the image and in the code; they must not change.

| User | uid | Group in the image (gid) | Runs |
| --- | --- | --- | --- |
| `thermite` | 10010 | `thermite` (10010) | The harness's controller: ledger, judge, scheduler, API |
| `builder` | 10020 | `builder` (10020) | Kit builds of candidates and champions |
| `run` | 10030 | `gpu` (10500) | Timed runs on the first judge device |
| `run-1` … `run-7` | 10031 … 10037 | `gpu-j1` … `gpu-j7` (10511 … 10517) | Timed runs on judge GPUs 2 to 8 |
| `lane-1` … `lane-16` | 10101 … 10116 | `lane-1` … `lane-16` (10101 … 10116) | A lane's commands and file tools; OpenCode and Claude Code sessions |
| `lane-1-dev` … `lane-16-dev` | 10201 … 10216 | `gpudev` (10501) | A lane's development runs |
| `agent-1` … `agent-16` | 10301 … 10316 | `agent-1` … `agent-16` (10301 … 10316) | A lane's Pi worker process. `agent-16` also runs the model check and planner calls under OpenCode or Claude Code |

| Group | gid | Owns |
| --- | --- | --- |
| `gpu` | 10500 | The GPU device nodes on a rig with one shared device; the first judge GPU on a rig with dedicated GPUs |
| `gpudev` | 10501 | The first development GPU |
| `gpuctl` | 10502 | The control nodes every CUDA process needs, on a rig with dedicated GPUs |
| `gpu-j1` … `gpu-j7` | 10511 … 10517 | Judge GPUs 2 to 8 |
| `gpu-d1` … `gpu-d7` | 10521 … 10527 | Development GPUs 2 to 8 |

The broker sets each process's groups by number when it starts it: a development run, for example, gets its device's group. The users have no home and no login shell. These numbers set the limits of a rig: 16 lanes, and 8 judge plus 8 development GPUs.

The [isolation check](rig-checks.md#isolation-check) tests these users, and [Isolation inside a rig](../explanation/isolation.md) explains them.

### How it runs

- **Entry point:** `tini`, then `node /opt/thermite/dist/harness/broker.js`.
- **As root.** The image sets no user. The broker needs root to start each role as its user, and stops at start with `fatal: not root, so roles cannot be separated` otherwise. Compose, the machine units and the cluster manifests keep only the capabilities `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and `SETUID`, and forbid gaining new privileges.
- **What a role's process sees.** Builds and timed runs get only `PATH`, `LANG=C.UTF-8`, `HOME` and `TMPDIR` (both the run's own directory) and `USER`, plus `CUDA_VISIBLE_DEVICES` on a rig with dedicated GPUs. Other `ENV` lines in a derived image do not reach them. A lane's commands also get their build cache: `THERMITE_LANE_CACHE` and `CCACHE_DIR` (both the lane's cache folder) and `CCACHE_MAXSIZE=8G`.
- **Port:** 8700, the harness API (`THERMITE_LISTEN`). No port is published.
- **Also set:** `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

### Paths

| Path | What | Owner and mode |
| --- | --- | --- |
| `/var/lib/thermite` | State: the ledger, git mirrors, kits, imports, models, builds and the harness's copy of each run's past research, `knowledge/<run>/` (`THERMITE_STATE_DIR`) | `thermite`, 0711. `ledger`, `git`, `kits` and `imports` are 0700; `models` and `builds` 0711, reachable only by exact path |
| `/scratch` | Workspaces, lane caches, the judge's runs and each run's research folder, `thermite/research/<run>/` with its [`knowledge/`](knowledge-base.md#a-runs-knowledge-folder) (`THERMITE_SCRATCH_DIR`). Emptied at every start; the harness puts a run's `knowledge/` back from its state when the run next needs it | root, 0755 |
| `/inbox` | What the supervisor fetched for the harness: project and kit bundles, models (`THERMITE_INBOX_DIR`) | Mounted read-only |
| `/outbox` | Exports the supervisor pushes (`THERMITE_OUTBOX_DIR`) | `thermite` with the supervisor's group (10010:10001), 2750 |
| `/keys` | Control's public key, `control-signing.pub` | Mounted read-only |
| `/run/thermite` | The broker's socket, `broker.sock` (`THERMITE_BROKER_DIR`) | Directory root and group `thermite`, 0750; socket 0660 |
| `/run/secrets` | Secret files | The broker closes their directory to 0700 at start |

At start the broker also closes `/tmp`, `/var/tmp` and `/dev/shm` to the roles (root and group `thermite`, mode 1770): each role has its own temporary directory. [Ports, volumes and secret files](ports-volumes-secrets.md) lists the volumes behind these paths.

## The supervisor image

| Part | Detail |
| --- | --- |
| Base | `NODE_IMAGE` |
| Packages | `git`, `openssh-client`, `tini`, `ca-certificates`, `python3` |
| Thermite | `/opt/thermite`, and the `thermite` command at `/usr/local/bin/thermite` |
| Claude Code | `/usr/local/bin/claude`, only when built with `CLAUDE_CODE_VERSION`. Advisors on a Claude subscription need it |
| User | `supervisor`, uid and gid 10001, home `/var/lib/thermite-supervisor/home`, where `ssh` keeps `~/.ssh` |
| Paths it owns | `/var/lib/thermite-supervisor` (its state), `/results`. `/outbox` is 10010:10001, 2750 |
| Entry point | `tini`, then `node /opt/thermite/dist/supervisor/main.js` |
| Ports | None |

## The one-container rig image

A RunPod pod runs one container. The one-container rig image runs a rig's harness and its supervisor in it. The broker runs as root, as in the harness image, and also starts the supervisor under the supervisor's own user, beside the role users. Nothing launches it yet: [goal 022](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/022-runpod-launch.goal) adds rigs on RunPod, and [goal 019](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/019-rig-only-entry.goal) the port control connects to.

It is the harness image with the supervisor added. Build the harness image first, on a CUDA 12.x base for a GPU pod, and name it in `HARNESS_IMAGE`. The CPU harness image works the same, for a test:

```sh
podman build -t thermite-harness -f containers/harness/Containerfile .
podman build -t thermite-rig --build-arg HARNESS_IMAGE=localhost/thermite-harness \
  -f containers/rig/Containerfile .
```

### What it adds to the harness image

| Part | Detail |
| --- | --- |
| Thermite | Nothing: the harness image's `/opt/thermite` already holds the supervisor's code |
| Packages | `openssh-client`, as in the supervisor image, for Git over SSH |
| User | `supervisor`, uid and gid 10001, home `/var/lib/thermite-supervisor/home`, as in the supervisor image. `/var/lib/thermite-supervisor` and its `home` are mode 0700 |
| Set-id files | None. The build removes every setuid and setgid bit after the last package, and fails if one is left. RunPod does not stop a process from gaining privileges through such a file (`no_new_privs` is off there), so a role could otherwise run a setuid program as its owner |
| `thermite-rig-start` | `/usr/local/bin/thermite-rig-start`, the entry point. See [How it starts](#how-it-starts) |
| Entry point | `thermite-rig-start`, then `tini`, then `node /opt/thermite/dist/harness/broker.js` |
| Port | 8000 (`EXPOSE 8000`), the port control is to connect to through RunPod's proxy. Nothing listens on it yet ([goal 019](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/019-rig-only-entry.goal)) |

### Settings the image sets

The launch gives the rest: `THERMITE_RIG_ID`, `THERMITE_CONTROL_PUBKEY` and the rig's other [settings](settings.md).

| Variable | Value | Effect |
| --- | --- | --- |
| `THERMITE_ONE_CONTAINER` | `1` | The broker also prepares and starts the supervisor. The harness waits for control's key as long as it takes. The isolation check also checks the container as a whole |
| `THERMITE_STATE_DIR` | `/workspace/thermite/harness` | The harness's state, on RunPod's volume (mounted at `/workspace`, kept when a pod stops) |
| `THERMITE_OUTBOX_DIR` | `/workspace/thermite/outbox` | The outbox, read by both parts |
| `THERMITE_INBOX_DIR` | `/workspace/thermite/inbox` | The inbox, read by both parts |
| `THERMITE_SUPERVISOR_HOME` | `/workspace/thermite/supervisor` | The supervisor's state |
| `THERMITE_SUPERVISOR_TOKEN_FILE` | `/workspace/thermite/secrets/supervisor-token` | The token between the two parts, made at first start |
| `THERMITE_CONTROL_PUBKEY_FILE` | `/etc/thermite/control-signing.pub` | Where the broker writes control's key, and both parts read it |
| `THERMITE_LISTEN` | `127.0.0.1:8700` | The harness API answers on loopback only |
| `HARNESS_URL` | `http://127.0.0.1:8700` | The supervisor reaches the harness there |
| `THERMITE_TUNNEL_PORT` | `8000` | The port of control's connection. Nothing reads it yet ([goal 019](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/019-rig-only-entry.goal)) |

### How it starts

1. `thermite-rig-start` removes every `RUNPOD_` variable from the environment: RunPod's API key, the pod's ID and the others. It passes the pod's ID on as `THERMITE_POD_ID`, unless that is set already, for the supervisor's connection to control ([goal 019](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/019-rig-only-entry.goal)). Then it starts `tini`, so no process of the rig has RunPod's variables, PID 1 included.
2. The broker, as root, prepares the harness's places as in the harness image, and the supervisor's:
   - its state folder, `THERMITE_SUPERVISOR_HOME`: the supervisor's, mode 0700, with a folder `tmp` emptied at every start. `/tmp` is closed to the supervisor, as to the roles;
   - the inbox: the supervisor's, with the controller's group `thermite`, mode 2750;
   - the token the supervisor uses on the harness API: made at first start in `THERMITE_SUPERVISOR_TOKEN_FILE` (root's, 0600, in a folder of mode 0700), and copied at every start to `harness-token` in the supervisor's state folder (the supervisor's, 0600);
   - control's command-signing public key: taken from `THERMITE_CONTROL_PUBKEY` (PEM, or PEM in base64) and written by root to `THERMITE_CONTROL_PUBKEY_FILE`, mode 0644.
3. As the supervisor's user, started the way the supervisor is, it tries to open each GPU device node. It records what happened in `supervisor.json` in its socket's folder, for the isolation check.
4. It starts the supervisor as `supervisor` (10001), with no_new_privs (`setpriv --no-new-privs`), and in the GPU fence with no card where the kernel has Landlock: neither the supervisor nor a program it starts (an advisor's) can open the GPU. Then it starts the controller as `thermite`, as in the harness image.

Without `THERMITE_CONTROL_PUBKEY`, or with a value that is not an Ed25519 public key, the broker logs why and writes no key. The harness then waits for the key file, and logs `waiting for control's public key` at once and every 10 minutes after. It does not stop and start again.

The supervisor's environment is the broker's, without RunPod's variables and without the harness's secret files, with `HOME` (its passwd home), `TMPDIR` (its `tmp`), `USER=supervisor` and `THERMITE_HARNESS_TOKEN_FILE` set. The roles get what they get in the harness image. The controller gets no `RUNPOD_` variable either, in every image.

### Restarts and stops

| When | The broker |
| --- | --- |
| The controller exits | Does what it does in the harness image: ends the controller's processes and every role's, and starts it again |
| The supervisor exits | Ends whatever the supervisor started (its process group and every process of its user), logs `supervisor exited; restarting`, and starts it again |
| A part exits again soon | Waits 2 seconds before the next start, then twice as long each time, up to 30 seconds. After a run of more than a minute it waits 1 second |
| It gets `SIGTERM` or `SIGINT`, as when the pod stops | Passes the signal to both parts and starts neither again. Once both have ended, it ends every role's processes, logs `stopped` and exits with the controller's exit code |

### Paths

| Path | What | Owner and mode |
| --- | --- | --- |
| `/workspace/thermite/harness` | The harness's state | As `/var/lib/thermite` in the harness image |
| `/workspace/thermite/outbox` | Exports for the supervisor | `thermite` with the supervisor's group (10010:10001), 2750 |
| `/workspace/thermite/inbox` | What the supervisor fetched for the harness | `supervisor` with group `thermite` (10001:10010), 2750 |
| `/workspace/thermite/supervisor` | The supervisor's state, its `harness-token` and its `tmp` | `supervisor`, 0700 |
| `/workspace/thermite/secrets` | Root's copy of the token between the two parts | root, 0700 |
| `/etc/thermite/control-signing.pub` | Control's key from the launch | root, 0644 |
| `/run/thermite/supervisor.json` | The broker's record of the supervisor's user, fence and GPU access | root, 0644, in the broker's folder (root and group `thermite`, 0750) |
| `/scratch` | As in the harness image, on the container's own disk | root, 0755 |

The [isolation check](rig-checks.md#the-one-container-image) checks the supervisor, set-id files and RunPod's variables in this image too.

## The control image

| Part | Detail |
| --- | --- |
| Base | `NODE_IMAGE` |
| Packages | `tini`, `ca-certificates`, `git`, `openssh-client` (for machines over SSH and Git over SSH), `unzip` |
| kubectl | `KUBECTL_VERSION`, v1.37.1 by default, checked against a pinned sha256, at `/usr/local/bin/kubectl`. The build stops with `no pinned kubectl for <arch>` on any architecture but amd64 and arm64 |
| Thermite | `/opt/thermite`, and the `thermite` command at `/usr/local/bin/thermite` |
| User | `thermite`, uid and gid 10001, home `/var/lib/thermite-control`. It has a passwd entry because OpenSSH refuses a user without one |
| Paths it owns | `/var/lib/thermite-control` (its state, `THERMITE_CONTROL_DIR`), `/keys` |
| Entry point | `tini`, then `node /opt/thermite/dist/control/main.js` |
| Port | 8800 (`THERMITE_CONTROL_LISTEN`) |

[Compatibility](compatibility.md) lists the architectures and versions each image is built and tested on.
