# Write a kit for your project

This guide takes a project you want a campaign to work on and gives it a kit: a tested, pinned recipe that the judge uses to build, run, time and check candidates. You need a git repository for the project, a way to build and run it non-interactively, and a way to tell a right answer from a wrong one. For what a kit is and why it is separate from the project, see [Kits](kits.md); every field used below is in the [kit reference](kit-reference.md).

`kits/smoke-cpu` in this repository is a complete small kit. Copy its shape:

```text
my-kit/
  kit.json        the manifest
  bench/build.sh  the build command, plus any driver sources the build compiles in
  check.mjs       the judge-side check
```

```json
{
  "schema_version": 1,
  "name": "smoke-cpu",
  "target": "cpu",
  "build": { "copy": ["bench"], "command": ["sh", ".kit/bench/build.sh"], "outputs": ["out/bench"] },
  "cells": {
    "small": { "n": 128, "reps": 240, "seed": 11, "work": 1006632960 },
    "held":  { "n": 192, "reps": 60,  "seed": 37, "work": 849346560 }
  },
  "run": { "command": ["{build:out/bench}", "{params}", "{out}"] },
  "metrics": { "flops_per_s": { "unit": "FLOP/s", "work": "work" } },
  "check": { "command": ["node", "{kit:check.mjs}", "{params_json}", "{out}"] }
}
```

## 1. Create the kit repository

Make a separate git repository for the kit. Keep it private if it will hold held-out inputs or reference outputs: anyone who can read the kit can read the held-out cells.

Set `target` to the driver type of the rigs that will measure: `cpu` or `cuda-gpu`.

## 2. Write the build

The build command runs as the builder user, with the working directory set to a fresh export of the candidate's commit. The export has no `.git` directory. Kit paths listed in `build.copy` are copied into the tree under `.kit/`, so a build script at `bench/build.sh` in the kit runs as `sh .kit/bench/build.sh`.

- **List every result in `build.outputs`**, as paths relative to the source tree. Anything not listed is discarded.
- **Make every output a regular file.** The build store refuses links. Versioned shared libraries are the usual trap, because `libfoo.so` and `libfoo.so.0` are symlinks. With CMake, configure with `-DCMAKE_PLATFORM_NO_VERSIONED_SONAME=ON`, or replace each link with a copy of its target at the end of the build.
- **Make the outputs relocatable.** The store moves the build. Binaries that load the build's own libraries need an `$ORIGIN` run path, for example CMake's `-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON`.
- **Size the build to its limits.** Set `timeout_s`, `rss_mib` and `disk_mib` for a cold build on the rig, and cap parallel jobs to fit the memory limit. A heavy CUDA build may need minutes and several GiB.

## 3. Define the cells

A cell is a named set of parameters for one run, such as a problem size, a seed or an input file name. Give each cell a numeric `work` value for every metric: the score is `work` divided by the run's wall time in seconds.

Add the cells you intend to hold out. Give them parameters different enough from the visible cells that tuning to the visible ones does not carry over by accident. The contract, not the kit, says which cells count and which are held out.

## 4. Write the run command

The run command executes one stored build on one cell, as the run user. Use the placeholders to reach the build, the cell's parameters, the output directory and the run's kit files.

- **Write outputs only to `{out}`,** as regular files.
- **Ship run-time helpers with `run.copy`.** The run cannot read the kit directory. List the driver scripts and inputs the run needs in `run.copy`, and reach them as `{kit:run/driver.py}`. The judge copies them fresh into every run, read-only. Don't ship them through the build: the candidate's build scripts run in the same tree and could rewrite them. The run can read what `run.copy` lists, so never list references or held-out inputs there.
- **Let the work dominate the time.** The judge times the whole process, including start-up and loading. Repeat the work, as the smoke kit's `reps` does, until it outweighs the fixed cost.
- **Pin everything that varies.** Pass thread counts explicitly, sized to the rig's CPU quota rather than the host's CPU count. Turn off any automatic tuning that would change parameters between runs, and set seeds.
- **Use only flags that this version of the project accepts.** Projects rename and remove flags. Run each command line once against the project's own build before the first dry run.
- **Read models from `{models:<sha256>}`** when the run needs an imported model.

## 5. Write the check

The check runs as the judge, from the kit directory, after every run that exits cleanly. It reads the judge's own copy of the parameters and the run's outputs, and prints one JSON object as the last line of its standard output:

```json
{"pass": false, "reasons": ["max abs error 0.31 above 0.002"], "max_err": 0.31}
```

- **Recompute or compare.** Derive the expected answer from the parameters, or compare it with a reference kept in the kit. Treat nothing in `{out}` as trusted.
- **Check that the candidate did the work.** If the project keeps a slow reference implementation, prove the fast path ran. The smoke kits count calls to the reference through a link-time wrap and fail the run if it was called.
- **Put the cause first in each reason, and keep it short.** Workers see up to 600 characters of a verdict's reasons, and a goal report keeps about 300 characters for each failed cell. Lead with the error line, such as an exception's message, not with the last lines of a log.
- **Report extra numbers as fields.** A goal with a `metric_threshold` can use any number the check reports, for example peak memory.

## 6. Add verifiers for goal campaigns

For each goal verified by code, add a verifier naming the cells that must all pass:

```json
"verifiers": { "correctness": { "cells": ["small", "held"] } }
```

A goal that should be held out needs at least one visible cell and one held-out cell. A verifier whose cells are all held out never shows as met.

## 7. Pin the kit in the contract

Commit the kit and name the commit in the contract's `project.kit`:

```json
"project": { "repo": "my-project", "kit": { "repo": "my-kit", "commit": "<40-character commit>" } }
```

Check the contract with `thermite contract validate <file>`. Any later change to the kit is a new commit, so a new contract version, and every build is redone.

## 8. Send the kit to a rig

Bundle the kit at the pinned commit and take its hash:

```sh
git -C my-kit bundle create ../my-kit.bundle main
shasum -a 256 ../my-kit.bundle
```

Place the bundle in the rig's inbox next to the project's bundle, then build the assignment and issue it through control:

```sh
thermite assign-payload --contract contract.json --run my-run-1 \
  --seed-repo my-project --seed-commit <commit> --bundle repos/my-project.bundle \
  --kit-repo my-kit --kit-commit <commit> --kit-bundle repos/my-kit.bundle \
  --kit-bundle-sha256 <sha256> --agents off > payload.json
thermite command --control <url> --token-file <file> --rig <rig> \
  --kind assign_campaign --payload @payload.json
```

Bundle and model paths are relative to the rig's inbox. With `--agents off`, the run is judge-only: the judge builds and measures, and no worker starts.

## 9. Test the kit without agents

1. **Run known candidates.** Keep a few patches with known verdicts next to the kit, as `kits/smoke-cpu/candidates` does: a real improvement, a no-op, a broken change, and a fallback to the reference. On the judge-only run, submit each patch with `thermite submit` from inside the harness container, as the smoke scripts do, and confirm each gets the verdict you expect.
2. **Read the dry run.** The judge-only run is seeded at the project's unmodified commit.
   - In a goal campaign, the judge validates the seed and writes a goal report. Every goal should be met or unmet for the reason you expect, not because a run failed on its own.
   - In a hill climb, the judge calibrates. Read the A/A noise it reports before choosing `min_effect`.

If the unmodified project does not build, the judge records an infrastructure error and the dry run stops. A run that fails on a goal's cell shows up as an unmet goal, with the run's error as its reason. Either way, fix the kit, commit, and start again.

You are done when the known candidates get their expected verdicts and the dry run's report fails or passes each goal for the reason you designed it to. Then assign the campaign again without `--agents off`.
