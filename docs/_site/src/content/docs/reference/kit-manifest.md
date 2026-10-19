---
title: "Kit manifest"
description: "Every field of kit.json, and the placeholders, processes, limits, outputs and outcomes of a kit."
type: reference
sidebar:
  order: 3
---

A **kit** is the judge's recipe for one project: how to build a candidate, run it on each input, time it and check its results. It is a git repository with `kit.json`, the manifest, at its root. Agents never see it. This page describes the manifest and how the [judge](glossary.md) uses it.

[Why the benchmark lives in a kit](../explanation/kits.md) says why kits exist. [Write a kit for your project](../how-to/campaigns/write-a-kit.md) and [Test a kit with known candidates](../how-to/campaigns/test-a-kit.md) give the steps.

This is the manifest of the CPU smoke kit in the repository, [`kits/smoke-cpu`](https://github.com/iammrduncan/thermite/blob/main/kits/smoke-cpu):

```json title="kit.json"
{
  "schema_version": 1,
  "name": "smoke-cpu",
  "target": "cpu",
  "build": {
    "copy": ["bench"],
    "command": ["sh", ".kit/bench/build.sh"],
    "outputs": ["out/bench"],
    "timeout_s": 120,
    "rss_mib": 1024,
    "disk_mib": 256
  },
  "cells": {
    "small": { "n": 128, "reps": 240, "seed": 11, "work": 1006632960 },
    "large": { "n": 256, "reps": 40, "seed": 23, "work": 1342177280 },
    "held": { "n": 192, "reps": 60, "seed": 37, "work": 849346560 }
  },
  "run": {
    "command": ["{build:out/bench}", "{params}", "{out}"],
    "timeout_s": 60,
    "rss_mib": 256,
    "disk_mib": 32
  },
  "metrics": {
    "flops_per_s": { "unit": "FLOP/s", "work": "work" }
  },
  "check": {
    "command": ["node", "{kit:check.mjs}", "{params_json}", "{out}"],
    "timeout_s": 60
  }
}
```

The build copies the kit's `bench` folder into the source tree and compiles the candidate. Each run executes the build on one cell's parameters. The check, the judge's own program, reads the run's outputs and says whether they are correct. The metric is the cell's `work` divided by the run's time on the judge's clock.

## Layout

A kit is a git repository. `kit.json` sits at its root; every other file belongs to the kit: build scripts, run drivers, the check, reference results. Scripts may be in any language the rig's image can run. A [contract](contract.md) names the kit and pins its commit in `project.kit`.

## `kit.json`

Unknown fields are refused at every level.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | `1` | required | The manifest format |
| `name` | text matching `^[a-z0-9][a-z0-9._-]{0,63}$` | required | The kit's name |
| `target` | text | required | The kind of device the kit measures on. This version has the drivers `cpu` and `cuda-gpu`. A rig only measures with a kit whose `target` is its own |
| `build.copy` | list of kit paths | `[]` | Kit files and folders copied into the source tree under `.kit/<path>` before the build |
| `build.command` | list of text, at least one | required | The build's command and arguments, run in the source tree. Placeholders are not expanded here |
| `build.outputs` | list of paths, at least one | required | Paths, relative to the source tree, that make up the build |
| `build.timeout_s` | integer ≥ 1 | 600 | The build's time limit, in seconds |
| `build.rss_mib` | integer ≥ 1 | 4096 | The build's memory limit, in MiB |
| `build.disk_mib` | integer ≥ 1 | 4096 | The build's disk limit, in MiB |
| `cells` | object | required | Every cell the kit can measure. See [Cells](#cells) |
| `run.copy` | list of kit paths | `[]` | Kit files and folders copied, read-only, into every run. A run reaches them as `{kit:<path>}` |
| `run.command` | list of text, at least one | required | One run of one build on one cell |
| `run.timeout_s` | integer ≥ 1 | 300 | A run's time limit, in seconds |
| `run.rss_mib` | integer ≥ 1 | 1024 | A run's memory limit, in MiB |
| `run.disk_mib` | integer ≥ 1 | 256 | A run's disk limit, in MiB |
| `metrics` | object | required | What the judge measures. See [Metrics](#metrics) |
| `check.command` | list of text, at least one | required | The check's command and arguments. See [Check output](#check-output) |
| `check.timeout_s` | integer ≥ 1 | 120 | The check's time limit, in seconds |
| `verifiers` | object | `{}` | Named verifiers for goal campaigns. See [Verifiers](#verifiers) |

### Rules across fields

| Rule | Message |
| --- | --- |
| A kit path (in `build.copy` or `run.copy`) is relative and normalized, stays inside the kit, has no `..`, does not start or end with `/`, and is not `.` | `a kit path is relative, normalized and inside the kit` |
| Each name in a verifier's `requires` is another verifier of the kit | `<name> is not another verifier of this kit` |
| Verifiers' `requires` do not form a loop | `verifier gates form a cycle` |
| Every `{kit}` or `{kit:<path>}` in `run.command` is in `run.copy` | `{kit:<path>} is not in run.copy (a run cannot read the kit)` |

### Cells

A **cell** is one measured input, a test case: a name and its parameters. The dashboard calls cells **cases**. `cells` maps each cell's name to an object of parameters, whose values are numbers, text or `true`/`false`. A run receives them through `{params}` and `{params_json}`.

The contract chooses which cells count: `cells` for every block, `held_out_cells` for confirmation only, and each goal's cells. A rate metric reads one parameter, named by its `work`, from each cell; time and check metrics need none.

### Metrics

`metrics` maps each metric's name to one of three kinds. The judge works out every value itself: a run never reports its own score.

| Kind | Form | Value |
| --- | --- | --- |
| Rate | `{"unit": "<unit>", "work": "<parameter>"}` | The cell's parameter named by `work`, divided by the run's time in seconds on the judge's clock. `unit` is required |
| Time | `{"unit": "s", "from": "time"}` | The run's time in seconds, on the judge's clock. `unit` defaults to `s`. A contract improves it with `"direction": "min"` |
| From the check | `{"unit": "", "from": "check", "field": "<field>"}` | A number the kit's check prints under `<field>` in its result line, for example an accuracy. `unit` defaults to empty |

Every value must be above zero, because the judge compares runs by their ratio. A run whose check prints no number above zero for a check metric is invalid: `the check reported no <field> above zero (got <value>)`. A rate whose `work` parameter is missing, zero or not a number is an infrastructure error: `kit metric <name>: bad work <value> or time <seconds>`.

The device's driver also refuses values it cannot believe. The `cpu` driver refuses values that are not finite; the `cuda-gpu` driver refuses values that are not finite or not above zero.

### Verifiers

`verifiers` maps each verifier's name to how a goal contract's `{"type": "code", "verifier": "<name>"}` goal is checked. A verifier passes when one run on each of its cells ends normally and passes the kit's check.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `cells` | list of cell names, at least one | required | The cells whose runs must all pass the check |
| `priority` | integer | 100 | The order verifiers run in: lower first. Goals are checked in this order and reported in the contract's order |
| `requires` | list of verifier names | `[]` | Gates: other verifiers that must pass first. If one does not, this verifier runs none of its cells, and its goal is unmet with `not run: it requires <names>, which did not pass`. A gate with no cells in this pass (all held out, or none held out) does not block |

## Placeholders

Placeholders go inside the arguments of `run.command` and `check.command`. `{name:sub/path}` is the placeholder's path joined with `sub/path`. Any other lowercase name in braces is an infrastructure error when the command runs: `unknown placeholder {<name>}`.

| Placeholder | In a run | In the check |
| --- | --- | --- |
| `{build}` | The arm's stored build (read-only) | The same build |
| `{params}` | The run's copy of the cell's parameters, as `key=value` lines | The judge's own copy |
| `{params_json}` | The run's copy of the cell's parameters, as a JSON object | The judge's own copy |
| `{out}` | The run's output folder, which it may write | The same folder, to read |
| `{kit}` | The run's read-only copy of the `run.copy` paths | The kit itself |
| `{models}` | The imported [model files](glossary.md) (data files such as a model's weights), one read-only file per SHA-256: `{models:<sha256>}` is one | The same |

## Processes

The judge runs each stage as its own Unix user, so a candidate cannot change the kit, the stored builds or the judge's records. [Isolation inside a rig](../explanation/isolation.md) says how the users are kept apart.

| Stage | User | Working folder | Environment |
| --- | --- | --- | --- |
| Build | `builder` | The source tree: a fresh export of the candidate's commit, without `.git` | `PATH`, `LANG=C.UTF-8`, `USER`, and `HOME` and `TMPDIR` set to the working folder |
| Run | `run`, whose group owns the device. On a rig with several judge cards, card *i* is timed by `run-<i>`, with that card's own group | The run's own folder, holding `params.txt`, `params.json` and `out/` | As for the build. With dedicated judge cards, `CUDA_VISIBLE_DEVICES` names the run's card. On a GPU rig, timed runs are pinned by default to the CPUs near their card (`THERMITE_RUN_CPUS`) |
| Check | The harness's own user, `thermite` | The kit | `PATH` only |

A run cannot read the kit. The kit files a run needs go in `run.copy`. Before each run, the judge copies them into a folder outside the run's working folder. The copies are plain files owned by the judge: folders `0555`, files `0444`, or `0555` when executable. Neither the build nor the run can change them. A link among them, or a path missing from the kit, is an infrastructure error: `kit run.copy: not a regular file or directory: <path>` or `kit run.copy: <path> is not in the kit`.

## Limits

| Limit | Build | Run | Check |
| --- | --- | --- | --- |
| Time | `build.timeout_s` | `run.timeout_s` | `check.timeout_s` |
| Memory: the summed resident memory of the user's processes, sampled every 100 ms | `build.rss_mib` | `run.rss_mib` | none |
| Disk: the working folder, sampled every 500 ms | `build.disk_mib` | `run.disk_mib` | none |
| Files: 50,000 or more files and folders, or folders nested 128 deep, count as over the disk limit | yes | yes | none |
| Processes and threads (`RLIMIT_NPROC`) | 512 | 256 | none |
| Output kept: the last part of standard output and standard error | 64 KiB | 64 KiB | 64 KiB |

When a build or run goes over a limit, every process of its user is ended. Processes still alive when the main process exits are ended too, and the files the user left in `/tmp`, `/var/tmp` and `/dev/shm` are removed. After a timeout, the judge waits up to 15 seconds more for the output to close. These limits end one build, run or check; they never end a campaign.

## Outputs

| Rule | Build outputs | Run outputs (`{out}`) |
| --- | --- | --- |
| Allowed | Plain files, each with one link, and folders | Plain files, each with one link, and folders |
| Refused | Symbolic links, hard links, devices, sockets, named pipes | Symbolic links, hard links, devices, sockets, named pipes |
| Most entries | 20,000 | 10,000 |
| Deepest nesting | 32 levels | 32 levels |
| Afterwards | Hashed, made read-only and stored. The hashes are checked again before every run; a mismatch is the infrastructure error `build store tampered: <key> <files>` | Read by the check, then removed with the run's folder |

## Check output

The check prints one JSON object as the **last line** of its standard output. The judge does not use its exit code.

A kit described on the **New campaign** page is different: control wraps its check command in a script that turns the exit code into this line. Exit 0 passes, and any other exit fails with `the check exited <code>: <its last output>`. When a check that exits 0 prints a JSON object with `pass` as its last line, that line is passed on as it is, so it can report a score.

| Field | Type | Meaning |
| --- | --- | --- |
| `pass` | boolean | The run is valid only when this is exactly `true` |
| `reasons` | list of text | Why the run failed. They are joined with `; ` into the verdict's reason; with none, the reason is `check failed` |
| any other field | any | Details. A `from: "check"` metric reads its number from here |

When the last line is not JSON, the run fails with `check produced no result (exit <code>): <last 300 characters of standard error>`.

## Outcomes

The judge measures **arms**: the candidate and, in a hill climb, the champion (the run's current best) beside it. A failure counts against the candidate only when it is the candidate's. When the champion's build or run fails, something is wrong with the rig or the kit, so it is an **infrastructure error**: the verdict is `crash_infra`, it never counts against the candidate, and the judge tries the job once more. [Verdicts and states](verdicts.md) describes every verdict.

| What happened | Candidate | Champion |
| --- | --- | --- |
| The build exits with an error, or an output is missing | `invalid`, and the failed build is remembered | Infrastructure error |
| The build's outputs are refused | `invalid`, and the failed build is remembered | Infrastructure error |
| The build is ended for time, memory or disk | `crash_candidate`, not remembered: the next try builds again | Infrastructure error |
| A run is ended for a limit, or exits with an error | `crash_candidate` | Infrastructure error |
| A run's outputs are refused | `invalid` | Infrastructure error |
| The check fails | `invalid` | Infrastructure error |
| The driver refuses a metric's value | `invalid` | Infrastructure error |

The reasons have these forms:

| Failure | Reason |
| --- | --- |
| Build | `build: ` and one of `build failed (exit <code>)`, `build outputs missing: <paths>`, `build killed (<timeout, memory or disk>)`, `build outputs refused: <problems>`, then the last 1,500 characters of the build's log |
| Run ended for a limit | `killed: <timeout, memory or disk>` |
| Run exited with an error | `exit <code>: <last 400 characters of standard error>` |
| Run outputs refused | `outputs refused: <problems>` |
| Driver refused a value | `implausible: <problems>` |

In a goal campaign, a failed run on a verifier's cell makes that goal unmet, with the run's failure as its reason, whichever arm it was.

Reasons are shortened where they are passed on:

| Where | Characters kept |
| --- | --- |
| A failed cell in a goal report, for a verifier | 300 |
| A failed cell in a goal report, for a metric threshold | 200 |
| A verdict's reasons in a worker's brief | 600 |
| A build's log in the verdict | the last 1,500 |

## Build cache

Each build has a key: the hash of the candidate's commit, the kit's commit, the kit's `build` section and the toolchain. The toolchain is the `cc` and `nvcc` versions, and the image's identity when `THERMITE_IMAGE_ID` is set. A build is made once for each key and reused after. A failed build is remembered as failed, unless it was ended for a limit.

## How a kit reaches a rig

A kit arrives as a `kit_bundle` import in the `assign_campaign` [signed command](signed-commands.md):

| Field | Value |
| --- | --- |
| `kind` | `kit_bundle` |
| `path` | The git bundle's path, relative to the rig's inbox |
| `repo` | The kit's repository name: an id, matching the contract's `project.kit.repo` |
| `commit` | The kit's full commit id, matching `project.kit.commit` |
| `sha256` | Optional. The bundle file's SHA-256, checked when given |
| `source` | Optional. Where the rig's supervisor fetches the commit before it passes the command on: `{"git": "<url>"}` with an optional `"access"` naming Git access that control keeps for a private repository, or `{"control": "kits/<name>"}` for a kit that control keeps itself |

The harness keeps the kit as the repository `kit-<repo>` and exports each commit it needs into its private state. `thermite assign --kit <url>` adds this import for you; see the [command line reference](command-line.md).

## The kit against the contract

When a run is assigned, the harness checks the kit against the contract before it creates the run. Each problem found is listed after `the kit does not fit the contract: `, joined with `; `:

| Problem | Message |
| --- | --- |
| The kit's `target` is not the rig's | `the kit measures on <kit target>, and this rig's target is <rig target>` |
| A cell named in `cells` or `held_out_cells` (hill climb) | `cells names cell <cell>, which the kit does not have`, or `held_out_cells names cell …` |
| A metric named by the objective, a secondary objective, a guard or a `min`/`max` hard constraint (hill climb) | `the objective names metric <metric>, which the kit does not have`, or `a secondary objective …`, `a guard …`, `a hard constraint …` |
| A goal's verifier | `goal <id> names verifier <verifier>, which the kit does not have` |
| A goal threshold's metric or cell | `goal <id> names metric <metric>, which the kit does not have`, or `goal <id> names cell <cell>, which the kit does not have` |

Before each job, the judge checks the target again. A mismatch then is an infrastructure error: `kit <name> measures <target>, this rig has <type>`.

Contract fields that refer to the kit:

| Contract field | Refers to | Checked when a run is assigned |
| --- | --- | --- |
| `project.kit` | The kit's `repo` and `commit` | Yes: the commit must be on the rig, and its `kit.json` valid |
| `cells`, `held_out_cells` (hill climb) | Cell names | Yes |
| `objective.primary.metric`, `objective.secondary[].metric`, `guards[].metric`, `hard_constraints[].metric` | Metric names | Yes |
| `monitor_only` | Metric names | No; the field is not used |
| `held_out_cells` (goal) | Cell names | No. A held-out cell the kit lacks fails as `no cell <cell>` when a goal is verified |
| `goals[].verify` `{"type": "code", "verifier": …}` | A verifier name | Yes |
| `goals[].verify` `{"type": "metric_threshold", "metric": …, "cells": …}` | A metric name in `metrics`, and cell names. A number the check prints counts only when `metrics` declares it as a `from: "check"` metric | Yes |
| `models` | Imported model files, reached as `{models:<sha256>}` | The files must be imported; the kit does not list them |
