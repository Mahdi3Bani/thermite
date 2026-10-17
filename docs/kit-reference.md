# Kit reference

The manifest, placeholders, processes, limits and outcomes of a project kit. For what a kit is, see [Kits](kits.md). For building one, see [Write a kit](write-a-kit.md).

## Layout

A kit is a git repository with `kit.json` at its root. Every other file is the kit's own: build scripts, run drivers, the check, references. Scripts may be in any language the rig's image can run.

## `kit.json`

Unknown fields are rejected at every level.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | `1` | required | Manifest version |
| `name` | string | required | `^[a-z0-9][a-z0-9._-]{0,63}$` |
| `target` | string | required | Driver type the kit measures on: `cpu`, `cuda-gpu` |
| `build.copy` | string[] | `[]` | Kit paths copied into the source tree under `.kit/` before the build |
| `build.command` | string[] | required | Build argv, run in the source tree. Placeholders are not expanded |
| `build.outputs` | string[] | required, at least 1 | Paths, relative to the source tree, that make up the build |
| `build.timeout_s` | integer | `600` | Build wall-time limit, seconds |
| `build.rss_mib` | integer | `4096` | Build memory limit, MiB |
| `build.disk_mib` | integer | `4096` | Build disk limit, MiB |
| `cells` | object | required | Cell name → parameters. Values are numbers, strings or booleans |
| `run.copy` | string[] | `[]` | Kit paths copied fresh into each run, read-only, and reached as `{kit:<path>}` |
| `run.command` | string[] | required | Run argv for one build on one cell |
| `run.timeout_s` | integer | `300` | Run wall-time limit, seconds |
| `run.rss_mib` | integer | `1024` | Run memory limit, MiB |
| `run.disk_mib` | integer | `256` | Run disk limit, MiB |
| `metrics` | object | required | Metric name → one of the three kinds below |
| `metrics.<name>` as `{unit, work}` | | | A rate: the cell parameter named by `work` divided by the run's time, from the judge's clock |
| `metrics.<name>` as `{unit, from: "time"}` | | | The run's time in seconds, from the judge's clock (`unit` defaults to `s`) |
| `metrics.<name>` as `{unit, from: "check", field}` | | | A number the kit's check works out from the run's outputs and prints in its JSON line, under `field` (`unit` may be empty) |
| `check.command` | string[] | required | Check argv |
| `check.timeout_s` | integer | `120` | Check wall-time limit, seconds |
| `verifiers` | object | `{}` | Verifier name → `{cells}`, for goal contracts |
| `verifiers.<name>.cells` | string[] | required, at least 1 | Cells whose runs must all pass the check |
| `verifiers.<name>.priority` | integer | `100` | Order in which verifiers run: lower first |
| `verifiers.<name>.requires` | string[] | `[]` | Gates: other verifiers that must pass first. If one does not, this verifier runs none of its cells, and its goal is unmet with "not run" |

Paths in `build.copy` and `run.copy` are relative to the kit and normalized, with no `..`. Neither can name the whole kit.

## Placeholders

Placeholders appear inside `run.command` and `check.command` arguments. `{name:sub/path}` expands to the path joined with `sub/path`. An unknown placeholder is an error. In `run.command`, every `{kit}` placeholder must name a path in `run.copy`, or the kit is refused.

| Placeholder | Expands to | Run | Check |
| --- | --- | --- | --- |
| `{build}` | The stored build directory (read-only) | yes | yes |
| `{params}` | The cell's parameters as `key=value` lines | yes, the run's copy | yes, the judge's copy |
| `{params_json}` | The cell's parameters as a JSON object | yes, the run's copy | yes, the judge's copy |
| `{out}` | The run's output directory | yes, writable | yes, to read |
| `{kit}` | The kit directory | The run's read-only copy of `run.copy` | yes, the kit itself |
| `{models}` | The imported models directory; a model is `{models:<sha256>}` | yes | yes |

## Processes

| Stage | User | Working directory | Environment |
| --- | --- | --- | --- |
| Build | `builder` | A fresh export of the candidate's commit, without `.git` | `PATH`, `LANG=C.UTF-8`; `HOME`, `TMPDIR` = the working directory; `USER` |
| Run | `run`, with the GPU device group | The run's directory: `params.txt`, `params.json`, `out/` | `PATH`, `LANG=C.UTF-8`; `HOME`, `TMPDIR` = the working directory; `USER` |
| Check | The judge's own user | The kit directory | `PATH` only |

The run user cannot read the kit directory. Kit files a run needs go in `run.copy`. Before each run, the judge copies them into a directory outside the run's working directory. The copies are regular files, owned by the judge and read-only (directories `0555`, files `0444`, or `0555` when executable). Neither the candidate's build nor its run can change them. A link among them, or a path missing from the kit, is an infrastructure error.

## Limits

| Limit | Build | Run | Check |
| --- | --- | --- | --- |
| Wall time | `build.timeout_s` | `run.timeout_s` | `check.timeout_s` |
| Memory: summed RSS of the user's processes, sampled every 100 ms | `build.rss_mib` | `run.rss_mib` | none |
| Disk: the working directory, sampled every 500 ms | `build.disk_mib` | `run.disk_mib` | none |
| Tasks, threads included (`RLIMIT_NPROC`) | 512 | 256 | none |

When a build or run goes over a limit, every process of its user is killed. Processes still alive when the main process exits are killed too.

## Outputs

| Rule | Build outputs | Run outputs (`{out}`) |
| --- | --- | --- |
| Allowed entries | Regular files and directories | Regular files and directories |
| Refused | Symlinks, hard links, devices, sockets, FIFOs | Symlinks, hard links, devices, sockets, FIFOs |
| Most entries | 20,000 | 10,000 |
| Deepest nesting | 32 levels | 32 levels |
| After acceptance | Hashed, read-only, re-verified before every run | Read by the check, then removed |

## Check output

The check prints one JSON object as the **last line** of standard output.

| Field | Type | Meaning |
| --- | --- | --- |
| `pass` | boolean | The run is valid only if this is exactly `true` |
| `reasons` | string[] | Why it failed. Joined into the verdict's reason |
| any other field | any | Details. A numeric field can be a goal's `metric_threshold` value |

If the last line is not JSON, the run fails with `check produced no result (exit <code>): <end of stderr>`.

## Metrics

A metric is measured by the judge, never taken from what the run prints:

- **A rate** (`{unit, work}`): `cells[<cell>][<work>]` divided by the run process's wall time in seconds.
- **Time** (`{from: "time"}`): the run process's wall time in seconds; a contract improves it with `direction: "min"`.
- **A number the check works out** (`{from: "check", field}`): the check, the judge's own program, reads the run's outputs and prints the number in its JSON line, for example `{"pass": true, "accuracy": 0.93}`. A run whose check reports no such number above zero is invalid.

Every value must be above zero: the judge compares runs by their ratio.

For a rate, the value of a run is `cells[<cell>][<work>]` divided by the run process's wall time in seconds, measured by the judge. A `work` value that is missing, zero or not a number is an infrastructure error. The driver rejects implausible values; the CPU driver rejects values that are not finite.

## Outcomes

| What happened | Candidate | Champion or other arm |
| --- | --- | --- |
| Build exits non-zero, or an output is missing | `invalid`; the failure is cached | Infrastructure error |
| Build outputs refused | `invalid`; the failure is cached | Infrastructure error |
| Build killed for time, memory or disk | `crash_candidate`; not cached | Infrastructure error |
| Run killed for a limit, or exits non-zero | `crash_candidate` | Infrastructure error |
| Run outputs refused | `invalid` | Infrastructure error |
| Check fails | `invalid` | Infrastructure error |
| Metric implausible | `invalid` | Infrastructure error |

In goal verification, a failed run on a verifier's cell makes that goal `unmet`, with the run's failure as its reason, for any arm. A verifier whose gate (`requires`) did not pass is not run: its goal is `unmet`, with "not run: it requires …, which did not pass". A gate with no cells in a pass (all held out, or none held out) does not block.

Reason lengths kept downstream:

| Where | Characters |
| --- | --- |
| A failed cell in a goal report (code verifier) | 300 |
| A failed cell in a goal report (metric threshold) | 200 |
| A verdict's reasons in a worker's brief | 600 |
| A build failure's log in the verdict | the last 1,500 |

## Build cache

The build key is a hash of the candidate's commit, the kit's commit, the `build` section and the toolchain: the image identity and the `cc` and `nvcc` versions. A build is made once per key. A failed build is cached as failed, unless it was killed for a limit.

## Import

A kit reaches a rig as an import of the `assign_campaign` command:

| Field | Value |
| --- | --- |
| `kind` | `kit_bundle` |
| `path` | The git bundle's path, relative to the rig's inbox |
| `repo` | The kit's repository name, matching the contract's `project.kit.repo` |
| `commit` | The kit commit, matching `project.kit.commit` |
| `sha256` | Optional. The bundle file's hash; checked when given |

The harness keeps the kit as the repository `kit-<repo>` and exports each commit into its private state. A kit whose `target` differs from the rig's driver type is an infrastructure error: `kit <name> measures <target>, this rig has <type>`.

## Contract fields that use a kit

| Contract field | Refers to |
| --- | --- |
| `project.kit` | `{repo, commit}` of the kit |
| `cells`, `held_out_cells` (hill climb) | Cell names |
| `objective.primary.metric`, `objective.secondary[].metric`, `guards[].metric`, `monitor_only` | Metric names |
| `held_out_cells` (goal) | Cell names |
| `goals[].verify` `{type: "code", verifier}` | A verifier name |
| `goals[].verify` `{type: "metric_threshold", metric, cells}` | A metric name or a numeric check field, and cell names |
| `models` | `{name, sha256}` of imported models, reached as `{models:<sha256>}` |
