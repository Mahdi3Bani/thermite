---
title: "Rig checks"
description: "The model route, isolation and smoke checks: what each tests, what it needs, its limits and every result it reports."
type: reference
sidebar:
  order: 10
---

A **rig** can check itself in three ways. Each check runs inside the rig's **harness** container and ends with one sentence that says whether it passed. [Check a rig](../how-to/operate/check-a-rig.md) shows how to run them; this page describes what each one does. The [glossary](glossary.md) explains the terms.

| Check | `check` value | On the dashboard | What it tests | Needs | Time limit | Needs an idle rig |
| --- | --- | --- | --- | --- | --- | --- |
| Model route | `model` | **Model route** | The rig's model answers with a correct tool call, through the same harness its agents use | A model route | 120 s | No |
| Isolation | `isolation` | **Isolation** | Each role's user is refused what it must not reach, and reaches what it must | The broker: the harness container running as root | 30 s for each role | Yes |
| Smoke | `smoke` | **Judge smoke** | The judge gives each change in a known set its expected verdict, on the rig's own device | A `cpu` or `cuda-gpu` target, and the smoke kits in the image | 3 hours for the whole check | Yes |

## How a check runs

- **The command.** A check starts with the signed `rig_check` command, with payload `{"check": "model" | "isolation" | "smoke", "force"?: true}`. The dashboard, the REST API, the command line and the MCP tool `issue_command` can all send it. See [Signed commands](signed-commands.md).
- **The result comes later.** The command returns as soon as the check starts. The rig records two events: `rig_check_started` (with an id, the check and `force`), then `rig_check_finished` with `ok`, the summary sentence (at most 2,000 characters) and details (at most 60,000 characters). The result reaches control with the rig's next report.
- **One at a time.** A rig runs one check at a time.
- **On its own.** When the harness runs under the broker, it runs the isolation check every time it starts, before its API, its judge or any agent. It uses `force`, since nothing else can be running yet. It runs the model check whenever control gives the rig a new model route, or right after the check that is running then.

### When a rig refuses

| The command fails with | Why |
| --- | --- |
| `this rig cannot run the <check> check` | The rig has no such check. The isolation check needs the broker |
| `the <check> check is still running` | Another check is running on this rig |
| `not now: <n> open trial(s) and <m> judge job(s): pause the rig's runs and let the judge finish first (each probe kills its role's processes)` | Isolation or smoke on a busy rig. A rig is busy while a trial is open or a judge job is queued or running. A paused run's queued judge jobs count too |

`"force": true` runs the isolation or smoke check on a busy rig anyway. Each isolation probe ends every process of the role it tests, so forcing it ends that work. The dashboard never forces a check.

### After a restart

When the harness restarts during a check, it records the check as finished with `ok: false` and the summary `interrupted: the controller restarted during the check (runs it paused stay paused)`. It closes a smoke run that was left open, with the reason `its smoke check was interrupted`.

### Where results show

- The rig's page on the dashboard, in its **Checks** block: **not run yet**, **running**, **passed** or **failed**, with when it ran and the summary sentence.
- The rig's history, and `checks` in `GET /v1/rigs/<rig>/view` on the [REST API](rest-api.md).
- The MCP tool `recent_events`. See [MCP tools](mcp-tools.md).

## Model route check

The check sends one short request through the rig's model route, the same way its workers and planner do. The request carries a random word such as `thermite-k3x9qa`, and the model must answer with a tool call that carries it back.

| The rig's [worker harness](glossary.md) | The model must |
| --- | --- |
| Pi (built in) | Call the `echo` tool with the word |
| OpenCode v2 | Run `echo <word>` with OpenCode's shell tool, so that the output holds the word |
| Claude Code | Run `echo <word>` with its Bash tool, the only tool it is given |

The details record the model, the time in seconds, whether a tool was called, the tokens in and out, the last error and the reply's text (first 300 characters). With Pi they also record the base URL, the reply's stop reason, whether it held thinking, the context window and the reply limit. With OpenCode they also record the base URL, and with Claude Code the subscription's usage.

### Results

| Summary | Meaning |
| --- | --- |
| `<model> answered with a correct tool call in <s> s` | Passed (Pi). OpenCode and Claude Code add ` (OpenCode)` or ` (Claude Code)` |
| `<model> failed the tool-call check: no answer in 120 s (is the model up?)` | No answer in time |
| `<model> failed the tool-call check: it called the tool with "<x>", not "<word>"` | A tool call with the wrong word |
| `<model> failed the tool-call check: no tool call: <error>` | The request failed with an error |
| `<model> failed the tool-call check: no tool call (stop: <reason>); it wrote: <text>` | The model answered without calling the tool. `; it wrote: <text>` appears only when it wrote some text |
| `<model> failed the tool-call check in OpenCode: <why>` | Failed in OpenCode. `<why>` is the last error, `its tool call did not print the word`, or `no tool call; it wrote: <text>` |
| `<model> failed the tool-call check in Claude Code: <why>` | Failed in Claude Code. `<why>` can also be `the subscription's usage window is full until <time>` |
| `no model route: set one on control's settings page (or in the rig's settings)` | The rig has no model route. See [Connect a model provider](../how-to/models/connect-a-provider.md) |

## Isolation check

The isolation check is the harness's **isolation selftest**. For each role, the broker runs one small probe script as that role's own user. The script tries each operation in a list and reports what happened. [Isolation inside a rig](../explanation/isolation.md) explains why each role has its own user.

The selftest also runs from a shell inside the harness container, as root:

```sh
thermite selftest isolation --force
```

It prints the whole report as JSON and exits with 1 when isolation does not hold. Without `--force` it refuses a busy rig with `the rig is busy: <reason>; rerun with --force to probe anyway`.

### Roles probed

| Role | Who it is |
| --- | --- |
| `builder` | The user that builds kits and candidates |
| `run` | The user that runs timed runs on the first (or only) judge device |
| `run-<i>` | The user of each further judge GPU, on a rig with dedicated GPUs |
| `lane-1` | A lane's plain commands |
| `lane-1+gpu` | A lane's development run on the device. On a rig with several development GPUs, once for each: `lane-1+gpu@2` and so on |
| `lane-1-dev` | The development-run user |
| `agent-1` | A lane's worker agent process |

### Probes every role must be refused

| Probe | Tries to | What |
| --- | --- | --- |
| `ledger` | Read | The ledger database |
| `state-list` | List | The harness's state directory |
| `kits` | List | The kits the harness checked out |
| `git-mirrors` | List | The harness's git mirrors |
| `models-list` | List | The model store |
| `builds-list` | List | The build store |
| `broker-socket` | Check for write access | The broker's socket |
| `outbox-write` | Check for write access | The outbox |
| `outbox-read` | List | The outbox |
| `runs-list` | List | The directory of the judge's runs |
| `tmp-create`, `var-tmp-create`, `shm-create` | Create a file | `/tmp`, `/var/tmp`, `/dev/shm` |
| `kit-by-path` | Read | A checked-out `kit.json`, reached by its full path. Skipped before any kit is checked out |
| `secret:<file>` | Read | Each secret file: the supervisor token, the proposer token and the model key files. The rig check also tries the stored model route |
| `build-overwrite` | Write | A file of a stored build. Skipped before any build exists |
| `run-kit-write`, `run-kit-create` | Write, create a file | A run's read-only copy of kit files, made the way the judge makes it |
| `controller-environ` | Read | The environment of the harness's controller process |
| `device:<node>` | Open | Each GPU device node, for roles that must not use the device |

### Probes that must succeed

| Probe | Who | What |
| --- | --- | --- |
| `run-kit-read` | The timing users (`run`, `run-<i>`) | Read the run's copy of kit files |
| `device:<own card>` and the control nodes | Each role with a GPU of its own (dedicated GPUs only) | Open its own card and the shared control nodes |
| `visible-gpus` | Each role with a GPU of its own | `nvidia-smi -L` lists exactly that role's card |

On a rig with one shared device, the `run` user and development runs are not probed for devices. See [Sharing a device](../explanation/sharing-a-device.md).

### Results

Each probe's result is the error the operation met (refused, as it must be), `readable` or `reachable` (succeeded, where it must), `sees <ids>` (`visible-gpus` listed exactly the role's card), or one of these failures:

| Marker | Meaning |
| --- | --- |
| `ALLOWED` | A probe that must be refused succeeded |
| `UNREADABLE <error>`, `UNREACHABLE <error>` | A probe that must succeed was refused |
| `WRONG GPUS <ids>` | `nvidia-smi` showed other cards than the role's own |
| `failed: exit <code> <stderr>` | The probe script itself failed |

| Summary | Meaning |
| --- | --- |
| `isolation holds: every probe of <n> roles came out as it must (devices: <devices>)` | Passed |
| `isolation does NOT hold (devices: <devices>): <role> <probe>: <result>; …` | Failed. Up to 12 failures are listed |
| `isolation does NOT hold (devices: <devices>): the device setup failed` | The dedicated GPU layout could not be set up |

`<devices>` is `shared`, `dedicated: judge <nodes>, development <nodes>`, or `dedicated, NOT SET UP: <error>`. The details hold every probe's result for every role, and the probes that were skipped.

## Smoke check

The smoke check runs a small campaign with no agents on the rig's own target. The changes it submits, called candidates, each have a known right verdict. It passes when every candidate gets it.

1. It picks the smoke kit for the rig's target: `smoke-cpu` for `cpu`, `smoke-cuda` for `cuda-gpu`. It reads the kits and their projects from `/opt/thermite/checks` in the harness image, or from `THERMITE_CHECKS_DIR`.
2. It makes a git repository of the project and one of the kit (without its candidates), with fixed dates, so the same files always give the same commits.
3. It assigns a judge-only run named `check-smoke-` and eight hexadecimal digits, of a campaign named `rig-check-<kit>-` and the first eight digits of the kit's commit. The contract is the image's `examples/contracts/smoke-cpu.json`, with the rig's target. Assigning pauses the rig's running runs, with the reason `replaced by check-smoke-…`.
4. It submits every candidate except `good`, and waits until each is settled: `judged`, `rejected_v0`, `duplicate`, `promoted`, `awaiting_approval` or `errored`.
5. It submits `good`, and waits for it the same way.
6. It closes its run (`the smoke check is done`) and resumes the runs it paused.
7. It compares each result with the expected one. A candidate expected to be `rejected_v0` is compared by its attempt state; the others by their verdict.

Every candidate is judged against the seed, the project as it is.

### The CPU candidates

| Candidate | The change | Expected |
| --- | --- | --- |
| `good` | Loops in i-k-j order, so the inner loop reads memory in order | `win_confirmed` |
| `noop` | The same algorithm with a renamed variable | `neutral` |
| `broken` | Skips half of the sum | `invalid` |
| `nobuild` | Does not compile | `invalid` |
| `timer` | Calls `clock_gettime`, a forbidden pattern | `rejected_v0` |
| `ref-edit` | Edits the reference code, outside the editable paths | `rejected_v0` |
| `fallback` | Calls the reference code instead of computing | `invalid` |
| `nan` | Returns NaN | `invalid` |
| `oom` | Touches 1 GiB of memory, over the run's 256 MiB limit | `crash_candidate` |
| `diskfill` | Writes 512 MiB, over the run's 32 MiB disk limit | `crash_candidate` |
| `overwrite` | Tries to overwrite the stored builds, then computes correctly | `neutral`, `inconclusive` or `regress` |
| `linger` | Leaves a process running in the background | `neutral`, `inconclusive` or `regress` |

### The CUDA candidates

| Candidate | The change | Expected |
| --- | --- | --- |
| `good` | Shared-memory tiling | `win_confirmed` |
| `noop` | A renamed variable | `neutral` |
| `broken` | Skips half of the sum | `invalid` |
| `fallback` | Calls the reference code | `invalid` |

### The smoke kits and contract

Both kits multiply two square matrices of floats. The build links the candidate's kernel with the kit's driver and wraps the reference function, so the kit can see whether the candidate called it. The kit's check computes the product again in double precision (the CUDA kit checks 64 evenly spaced rows, since its matrices are larger), allows an error of at most 0.002, and fails a run with values that are not numbers or that called the reference.

| | `smoke-cpu` | `smoke-cuda` |
| --- | --- | --- |
| Cases (`n`) | `small` 128, `large` 256, `held` 192 | `small` 512, `large` 1024, `held` 768 |
| Metric | `flops_per_s` (FLOP/s) | `flops_per_s` (FLOP/s) |
| Build limits | 120 s, 1024 MiB memory, 256 MiB disk | 300 s, 2048 MiB memory, 512 MiB disk |
| Run limits | 60 s, 256 MiB memory, 32 MiB disk | 120 s, 2048 MiB memory, 64 MiB disk |
| Check time limit | 60 s | 300 s |
| Compiler | `cc` | `nvcc`, for the `sm_60` architecture |

The contract measures `small` and `large`, keeps `held` for confirmation, and lets changes touch only `src/kernel/**`. It sets `min_effect` 0.1, `equivalence_band` 0.05 and `runs_per_cell` 3, because timing on a shared CPU is noisy. Its audit triggers are set to 1000, so no smoke candidate is audited. It forbids added lines that match `clock_gettime`, `gettimeofday`, `\brdtsc`, `\btimes\s*\(`, `__real_`, `__wrap_` and `thermite_ref_calls`.

### Results

| Summary | Meaning |
| --- | --- |
| `smoke on <kit>: all <n> candidates were judged as expected (run <run>)` | Passed |
| `smoke on <kit>: <k> of <n> candidates were judged otherwise: <name> expected <x>, got <y>; …` | Failed. Each wrong candidate is listed |
| `there is no smoke kit for a <type> target` | The rig's target is neither `cpu` nor `cuda-gpu` |
| `the smoke kit is not in this image (<dir>)` | The image has no smoke kit at that path |
| `the judge did not settle <names> within 180 min` | The 3-hour limit passed |

The details list each candidate with its expected result, its actual result and its attempt id. The check's run stays on the dashboard, so its attempts can be read afterwards. While it runs, it shows under **At work now** on **Campaigns**. After it, its campaign shows on **Campaigns** under the **Rig checks** and **All** filters (the default filter hides rig checks), and the run is under **Earlier runs** on the campaign's page. [Your first run](../tutorials/first-run.md) walks through one.
