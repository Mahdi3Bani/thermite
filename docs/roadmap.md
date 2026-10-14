# Roadmap

v1 is being built in milestones. Each milestone ends with checks that must pass before the next one starts.

| Milestone | Delivers | Status |
| --- | --- | --- |
| **M1: core** | Contracts for all three modes, the ledger, the harness API, signed commands and verified imports, container images and a local compose stack | Built |
| **M2: judge** | Process isolation, target drivers (CUDA GPU and CPU), the build and run pipeline, gates, timing owned by the executor, statistics, verdicts. Acceptance tests with known good, broken, no-op and tampering candidates | Built; accepted on the CPU target, GPU acceptance next |
| **M3: control** | Supervisor reporting and command relay, git export, the central control service with dashboard, API and MCP | Built; accepted with two local units |
| **M4: agents** | Stateless workers with submit, status and development-run tools; the planner; goal and research modes | Built; accepted with a scripted model, real-model runs next |
| **M5: supervision** | Teacher review with cited directives, audits, the review panel for subjective goals, "not possible" endings, propagation and cross-verification across units, daily reports, lifecycle control and full reset | Built; local acceptance in progress |
| **M6: test fire** | Several campaigns in all three modes running unattended for days, with deliberate failures injected along the way | Planned |

## Later

- Population and evolutionary search strategies.
- Pareto champion sets.
- More target drivers.
- Automatic planning across units.
- Signed receipts.
- Tracing.
