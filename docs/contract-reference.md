# Contract reference

A contract is a JSON file that says what a campaign is for and what counts: the project, the
kit, the mode and its objective or goals, and the limits. The owner approves a contract; runs
are assigned from it. Any change to a contract is a new `version`, and the old one stays in each
rig's record.

Check a contract before you assign it:

```sh
npx thermite contract validate contract.json
```

The command prints the contract's mode, campaign, version and sha256. It warns when a hill-climb
or goal contract names no kit. When a run is assigned, the harness also checks the kit against
the contract: the rig's target, and the cells, metrics and verifiers the contract names.

Examples: [`examples/contracts/`](../examples/contracts/) has a hill climb (`smoke-cpu.json`), a
goal campaign (`goal-example.json`) and a research campaign (`research-example.json`).

## Fields every mode has

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `schema_version` | `1` | required | The contract format |
| `campaign` | id | required | The campaign's name: lowercase letters, digits, `.`, `_`, `-`; up to 64 characters |
| `version` | integer ≥ 1 | required | A new number for any change |
| `title` | string | required | A human title |
| `mode` | `hill_climb`, `goal` or `research` | required | Which kind of campaign; selects the fields below |
| `project.repo` | string | required | The project's name on the rig (its repository mirror) |
| `project.commit` | full commit id | none | A pinned starting commit; usually the assignment's seed says it instead |
| `project.kit.repo`, `project.kit.commit` | string, full commit id | none | The kit and its pinned commit; the judge needs one for hill-climb and goal campaigns |
| `target.type`, `target.class` | strings | none (hill climbs need one) | The measurement target, for example `cpu` or `cuda-gpu`, and its class |
| `models` | `[{name, sha256}]` | `[]` | Model files the campaign uses, pinned by sha256 |
| `lanes.count` | 1–64 | 2 | Parallel worker lanes |
| `lanes.trials_per_epoch` | ≥ 1 | 3 | Trials per lane in each planner epoch |
| `lanes.limits` | object | see below | What each lane may use |
| `budget.wall_hours` | number | none | Stop agent work after this many hours. No default: a campaign runs until its goals or metrics are met |
| `budget.device_hours`, `budget.llm_usd` | numbers | none | Other caps, only when set |
| `budget.max_open_attempts` | integer | 4 | Submissions the judge may hold at once before lanes wait |
| `min_duration`, `max_duration` | durations such as `90s`, `30m`, `8h`, `7d` | none | Research needs `min_duration`; `max_duration` may not be shorter |
| `search_policy.allowed_purposes`, `.blocked_patterns` | strings, regular expressions | `[]` | What public search may be used for; matching queries are refused |
| `notes` | string | none | Notes from the campaign's author, shown to the planner and the workers |

### Lane limits (`lanes.limits`)

| Field | Range | Default | Meaning |
| --- | --- | --- | --- |
| `run_timeout_s` | 10–7200 | none | A lane command's time limit. Unset: a command runs until it finishes or the trial ends |
| `run_rss_mib` | 256–16384 | 2048 | Memory for everything a lane runs at once |
| `workspace_mib` | 256–65536 | 2048 | The trial's workspace on disk, build trees included |
| `dev_run_timeout_s` | 10–3600 | none | A development run's time limit. Unset: none on a dedicated development card; on a device the judge shares, 300 s so the judge gets it back |
| `dev_run_rss_mib` | 256–16384 | 4096 | Memory for a development run |
| `trial_minutes` | 1–1440 | the rig's default | One trial's length; the lane's next trial starts fresh |

## Hill climb and goal: what candidates may change

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `editable_paths` | globs, at least one | required | Paths a candidate may change. Any other change is refused before building |
| `forbidden_patterns` | regular expressions | `[]` | An added line matching one is refused before building |

## Hill climb (`"mode": "hill_climb"`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `objective.primary.metric` | kit metric | required | The metric to improve |
| `objective.primary.direction` | `max` or `min` | required | Which way is better |
| `objective.primary.min_effect` | fraction > 0 | required | The smallest gain that counts, for example `0.05` for 5% |
| `objective.policy` | `single` or `lexicographic` | `single` | How secondary metrics break ties |
| `objective.secondary` | `[{metric, direction}]` | `[]` | Further metrics, in order |
| `cells` | kit cells, at least one | required | The cells measured for every candidate |
| `held_out_cells` | kit cells | `[]` | Measured only at confirmation, so a change cannot be tuned to them |
| `guards` | `[{metric, direction, max_step_regression, max_total_regression}]` | `[]` | Metrics that may not get worse beyond these fractions, per promotion and overall |
| `hard_constraints` | `[{kind: min or max, metric, value}]` | `[]` | Absolute bounds on a cell's mean. A `{kind: check, check}` entry records a check's name; the kit's check runs on every candidate regardless |
| `monitor_only` | metrics | `[]` | Reported, never judged |
| `acceptance.alpha_screen`, `.alpha_confirm` | fractions | 0.1, 0.05 | Error rates for screening and confirmation |
| `acceptance.equivalence_band` | fraction | 0.005 | A difference this small counts as none |
| `acceptance.looks` | block counts | `[3, 6, 9]` | When screening may decide early |
| `acceptance.confirm_blocks` | integer | 5 | Fresh blocks for confirmation |
| `acceptance.runs_per_cell` | 1–9 | 1 | Runs per arm and cell in each block (their median counts) |
| `acceptance.audit.ratio_to_median`, `.absolute` | numbers | 3, 0.15 | Gains this many times the median confirmed gain, or above this fraction, wait for an audit |

## Goal (`"mode": "goal"`)

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `goals` | list, at least one | required | The goals (below) |
| `success.policy` | `all_required` or `k_of_n` | `all_required` | When the campaign is complete |
| `success.k` | integer | none | For `k_of_n`: how many goals must be met |
| `deliverable` | string | required | What a verified solution is: a commit, an artifact or a report |
| `insufficient` | strings | `[]` | Outcomes that must never be reported as success |
| `adversarial_checklist` | strings | `[]` | Failure modes every candidate is audited for |
| `infeasibility.allowed` | boolean | `false` | Whether "not possible" may be proposed |
| `infeasibility.min_refuted_approaches` | integer | none (needed when allowed) | How many approach families must be refuted first |
| `independence_epochs` | integer | 2 | Epochs in which lanes see no other lane's evidence |
| `min_live_families` | integer | 2 | Approach families kept alive at once |
| `threshold_reps` | 2–20 | 5 | Runs per cell when a metric threshold is checked |
| `held_out_cells` | kit cells | `[]` | Measured only at confirmation |

Each goal:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | id | required | Unique among the goals |
| `description` | string | required | What the goal means, for people and agents |
| `priority` | integer ≥ 1 | 1 | Lower runs first |
| `required` | boolean | `true` | Whether `all_required` needs it |
| `parent` | goal id | none | Groups goals into a tree |
| `verify` | one of the three below | required | How the judge checks it |

`verify` is one of:

- `{"type": "code", "verifier": "<name>"}`: a verifier in the kit, which may require others to pass first. See [Kit reference](kit-reference.md).
- `{"type": "metric_threshold", "metric": "<metric>", "op": ">=", "value": 1.5e8, "cells": ["big"]}`: the metric's interval over `threshold_reps` runs must clear the bound. `op` is `>=`, `<=`, `>` or `<`.
- `{"type": "review", "criteria": ["..."]}`: a subjective goal. A blind panel of models reviews it, and it is met only when the owner accepts.

## Research (`"mode": "research"`)

Research campaigns have no `editable_paths`, kit or cells. They need `min_duration`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `topic` | string | required | What to research |
| `questions` | strings, at least one | required | The questions claims must answer |
| `seeds` | URLs | `[]` | Starting pages; without web search, workers follow links from these |
| `scope.include_domains`, `.exclude_domains`, `.source_types`, `.languages` | strings | `[]` | Where sources may come from |
| `report_cadence.digest_minutes`, `.report_hours` | numbers | 60, 24 | How often digests and reports are written |
| `quality.min_independent_sources` | integer | 2 | Domains a claim needs to count as a finding. Quotes are always checked verbatim |
| `fetch_policy.respect_robots` | boolean | `true` | Obey robots.txt |
| `fetch_policy.per_domain_per_minute` | integer | 6 | Fetch rate per domain |
| `fetch_policy.max_bytes` | integer | 5000000 | Largest page fetched |
