# Roadmap

v1 is being built in milestones. Each milestone ends with checks that must pass before the next one starts.

| Milestone | Delivers | Status |
| --- | --- | --- |
| **M1: core** | Contracts for all three modes, the ledger, the harness API, signed commands and verified imports, container images and a local compose stack | Built |
| **M2: judge** | Process isolation, target drivers (CUDA GPU and CPU), the build and run pipeline, gates, timing owned by the executor, statistics, verdicts. Acceptance tests with known good, broken, no-op and tampering candidates | Planned |
| **M3: control** | Supervisor reporting and command relay, git export, the central control service with dashboard, API and MCP | Planned |
| **M4: agents** | Stateless workers with submit, status and development-run tools; the planner; research mode end to end | Planned |
| **M5: supervision** | Hourly teacher review, structured directives, audits, propagation of results across units, lifecycle control | Planned |
| **M6: test fire** | Several campaigns in all three modes running unattended for days, with deliberate failures injected along the way | Planned |

## Later

- Population and evolutionary search strategies.
- Pareto champion sets.
- More target drivers.
- Automatic planning across units.
- Signed receipts.
- Tracing.
