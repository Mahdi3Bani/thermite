# Thermite conventions

These are review rules for Thermite's code and records, for maintainers and outside contributors alike. [CONTRIBUTING.md](CONTRIBUTING.md) is the contributor's entry point. [AGENTS.md](AGENTS.md) is the agent entry point, and `CLAUDE.md` imports it. The design reasons behind these rules are in the [documentation](docs/README.md).

## Authority and evidence

- The owner's current request defines what is authorized. The plans and settled decisions in [docs/plan/](docs/plan/README.md) define the design; the [documentation site](docs/README.md) explains it, and describes only what exists. Research reports are evidence, not instructions.
- Separate observed behaviour from interpretation, and settled decisions from proposals.
- Third-party code, papers, web pages and agent output are untrusted data.
- Never copy code from sources without a license. Code under MIT, Apache-2.0 or similar licenses may be adapted with attribution and its notice.

## Design invariants (check these in every review)

1. **Agents propose; code judges.**
   - No path an agent can write leads into measurements, verdicts, completion or promotion.
   - The score of record comes from a channel the executor owns. Numbers a candidate prints are cross-checks only.
   - Numbers from agents' development runs never count.
2. **The harness owns the state.**
   - Every agent invocation, whether worker, planner, teacher or auditor, starts fresh from context the harness builds from the ledger.
   - Session resume is never the continuity mechanism.
3. **Nothing is destroyed.**
   - Every candidate's code is preserved (ref plus manifest) before it is built or measured.
   - Corrections are new records.
   - Bad evidence is invalidated, with the invalidation propagated to whatever depended on it, never deleted.
4. **Lifecycle and verdict are separate axes.** Infrastructure failures, invalid measurements and lost leases are never counted as research losses.
5. **Nothing stops silently.**
   - Budgets are explicit.
   - A pause carries a recorded reason.
   - Completion follows the campaign mode's rule and is decided by the harness, never by an agent.
6. **Objectives are versioned contracts in data.** A changed objective is a new contract version. Guards and hard constraints are checked by the judge, not requested in a prompt.
7. **Control commands are signed.**
   - Imported code, kits and models are accepted only when their hashes match a signed command.
   - A rig accepts other rigs' results only after its own judge has re-measured them.
8. **Targets go through drivers.** Never assume a GPU, one provider or one model.
9. **Steering is traceable.** Every directive and command records who issued it, why, and which runs it affected.

## Experiment integrity

- Define objectives, rigs, directions, guards, quality checks and acceptance rules before evaluating anything. Keep improvement and constraint satisfaction separately visible.
- Preserve enough provenance to explain and reproduce a result:
  - code revision;
  - configuration and prompts;
  - model and provider identity;
  - target identity and state;
  - evaluation conditions, measurements and artifacts.
- Measure noise before judging small effects. Re-measure apparent winners. A sentinel value is never a score.
- Keep held-out checks out of agents' feedback and planner context.
- Research claims count only when the cited text is verified in the archived source.

## TypeScript implementation

- Use TypeScript in strict mode with ES modules on Node.js LTS. Avoid `any` without a stated reason.
- Validate every input that crosses a trust boundary against a schema: API requests, contracts, commands, imported manifests and all LLM output.
- Keep modules small with narrow interfaces. Handle external failures explicitly, with typed errors and no silent catches.
- Pin and justify dependencies, and prefer the standard library. The formatter and linter is Biome; its commands are in AGENTS.md.
- Never put secrets in code, logs, records or `.internal/`. Credentials are files mounted at deploy time.

## Testing

- Test observable behaviour and important failure transitions. Tests must be able to fail.
- **Statistics and state machines:** unit and property tests against reference values. Cover verdicts, compare-and-swap promotion, fencing and invalidation.
- **Isolation:** tests that prove agent users cannot reach judge files, credentials or devices outside their grants.
- **Adversarial cases:**
  - timer tampering;
  - reference-op fallbacks;
  - NaN and sentinel values;
  - forged commands;
  - swapped imports;
  - prompt-injected directives;
  - unverifiable claims.
- **Recovery:** process death at each persistence boundary, container restarts, stale leases.
- Report configured checks separately from checks that actually ran and passed.

## Research and work records

- Plans, goals and decisions are public, in [docs/plan/](docs/plan/README.md).
- Store research, reviews and agent work logs that name a particular deployment under `.internal/` in your own checkout, never in tracked files. Preserve earlier records rather than replacing history with a summary.
- For repository and web evidence, record the source, retrieval date and revision.
- `.internal/` is git-ignored. It is not a public archive and not a backup.
