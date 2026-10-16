# Settings reference

Each container reads its settings from environment variables. Secrets are files: a variable
ending in `_FILE` names the file, and the value never sits in the environment. `compose.yaml`
passes the everyday settings through from your shell or a `.env` file, with the same defaults;
add the others to it when you need them.

Research settings that belong to one campaign live in its [contract](contract-reference.md)
or its assignment instead: lane limits, trial length, budgets and the run's promotion policy.

## Control

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_CONTROL_LISTEN` | `0.0.0.0:8800` | Address for the dashboard, API and MCP |
| `THERMITE_CONTROL_DIR` | `/var/lib/thermite-control` | Control's state: its store and its command-signing key |
| `THERMITE_CONTROL_PUBKEY_EXPORT` | none | Where to write the public key, for the rigs to verify commands |
| `THERMITE_CONTROL_ADMIN_TOKEN_SHA256` or `_FILE` | required, one of them | The owner's credential: the token's SHA-256 (deployed; make it with `thermite token new`), or a token file (local development) |
| `THERMITE_CONTROL_OPERATOR_TOKEN_SHA256` or `_FILE` | none | An operating agent's credential: steer and message agents, never approve |
| `THERMITE_CONTROL_AGENT_TOKEN_SHA256` or `_FILE` | none | An agent's credential: steer, never message or approve |
| `THERMITE_CONTROL_READ_TOKEN_SHA256` or `_FILE` | none | A read-only credential |
| `THERMITE_CONTROL_RIG_TOKENS_FILE` | required | A JSON file: `{"<rig>": "<token>"}`, one token per rig |
| `THERMITE_CONTROL_REQUIRE_KEY_ACCEPT` | off | `1`: the owner accepts each rig's first report key on the dashboard |
| `THERMITE_CONTROL_SESSION_DAYS` | 30 | How long an unused dashboard sign-in lasts |
| `THERMITE_CONTROL_STALE_SECONDS` | 180 | A rig with no report for this long shows as stale |
| `THERMITE_LIFECYCLE` | none | `compose` or `kubernetes`: lets control restart rigs and finish a full reset |
| `THERMITE_COMPOSE_PROJECT`, `THERMITE_COMPOSE_SERVICES`, `THERMITE_ENGINE_SOCKET` | `thermite`, `{}`, `/run/engine.sock` | For `compose`: the project, each rig's service names, and the container engine's socket |
| `THERMITE_K8S_NAMESPACE`, `THERMITE_K8S_SELECTOR_HARNESS`, `THERMITE_K8S_SELECTOR_SUPERVISOR` | `ar-{rig}`, `app.kubernetes.io/component=harness` and `=supervisor` | For `kubernetes`: where each rig's pods are and how to find them |
| `THERMITE_K8S_API`, `THERMITE_K8S_TOKEN_FILE`, `THERMITE_K8S_CA_FILE` | in-cluster values | For `kubernetes` outside the cluster: the API server and its credentials |

## Harness

### The rig and its target

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_RIG_ID` | required | The rig's name, as control knows it |
| `THERMITE_TARGET` | `cpu` | `cpu` or `cuda-gpu` |
| `THERMITE_TARGET_CLASS` | `generic-cpu`, or `cuda-gpu` | The target's class (contracts and kits name it) |
| `THERMITE_GPU_INDEX` | 0 | The judge's GPU |
| `THERMITE_DEV_GPU_INDEX` | none | A second GPU for the agents' development runs. Unset: development runs share the judge's GPU and wait for it |
| `THERMITE_RUN_CPUS` | `auto` on a GPU rig, otherwise `off` | CPUs timed runs are pinned to: `auto` (the GPU's local CPUs), `off`, or a CPU list |
| `THERMITE_CALIBRATION_BLOCKS` | 6 | Blocks of the A/A calibration that measures the rig's noise when a run starts |
| `THERMITE_PROMOTION` | `auto` | The rig's default promotion policy, `auto` or `owner_approval`, for runs assigned without their own |

### Agents

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_MODEL_BASE_URL` | none (agents off) | An OpenAI-compatible endpoint with tool calling, ending in `/v1` |
| `THERMITE_MODEL` | none | The model's name at that endpoint |
| `THERMITE_MODEL_API_KEY_FILE` | none | The endpoint's key |
| `THERMITE_MODEL_CONTEXT_WINDOW` | 0 (unknown) | The model's context per request. Known, each reply is clamped to the room left |
| `THERMITE_MODEL_MAX_TOKENS` | 8192 | The cap on each reply, thinking included |
| `THERMITE_MODEL_REASONING_EFFORT` | none | `none`, `low`, `medium` or `high`, sent as `reasoning_effort` |
| `THERMITE_MAX_TRIALS` | 1 | Trials (lanes) at work at once on this rig |
| `THERMITE_TRIAL_MINUTES` | 20 | A trial's length when its contract sets none |
| `THERMITE_MAX_TURNS` | none | A cap on a trial's turns, only when set |
| `THERMITE_LLM_USD_PER_MTOK_IN`, `_OUT` | none | Prices per million tokens, for a contract's `llm_usd` budget |
| `THERMITE_RESEARCH_MAX_MB` | none | A cap on a research campaign's archived corpus, only when set |

The model settings' older names, `QWEN_*`, are still read when the new ones are unset.

### Places and exports

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_STATE_DIR` | `/var/lib/thermite` | The ledger, kits, builds and models |
| `THERMITE_SCRATCH_DIR` | `/scratch` | Workspaces, builds in progress and runs |
| `THERMITE_INBOX_DIR` | `/inbox` | Where imports arrive (read-only to the harness) |
| `THERMITE_OUTBOX_DIR` | `/outbox` | Where exports leave for the supervisor |
| `THERMITE_OUTBOX_GID` | 10001 | The supervisor's group, which may read the outbox |
| `THERMITE_EXPORT_MINUTES` | 60 | How often the harness exports results |
| `THERMITE_LISTEN` | `0.0.0.0:8700` | The harness API, reached only by its supervisor |
| `THERMITE_BROKER_DIR` | `/run/thermite` | Where the broker's socket lives |
| `THERMITE_SUPERVISOR_TOKEN_FILE`, `THERMITE_PROPOSER_TOKEN_FILE` | required, optional | The supervisor's token; a proposer's token (people submitting patches by hand) |
| `THERMITE_CONTROL_PUBKEY_FILE` | required | Control's public key, to verify commands |
| `THERMITE_ALLOW_UNSEPARATED` | off | `1`: run without separate users when not root. Development only |

## Supervisor

| Variable | Default | Meaning |
| --- | --- | --- |
| `THERMITE_RIG_ID` | required | The rig's name |
| `HARNESS_URL` | required | Its harness, for example `http://harness:8700` |
| `CONTROL_URL` | none | Control. Unset: the supervisor reports nowhere |
| `THERMITE_HARNESS_TOKEN_FILE`, `THERMITE_CONTROL_TOKEN_FILE` | required | Its tokens for the harness and for control |
| `THERMITE_POLL_SECONDS` | 60 | How often it reports the harness's events to control |
| `THERMITE_COMMAND_POLL_SECONDS` | 5 | How often it fetches control's commands. `0` puts them back on the report round |
| `THERMITE_LIVE_INTERVAL_MS` | 3000 | How often it relays the live view |
| `THERMITE_SUPERVISOR_HOME` | `/var/lib/thermite-supervisor` | Its state: relay cursor, results repository, fetched sources, advisor records |
| `THERMITE_INBOX_DIR`, `THERMITE_OUTBOX_DIR` | `/inbox`, `/outbox` | The harness's inbox (it writes imports there) and outbox (it reads exports) |
| `THERMITE_RESULTS_REMOTE` | none | The results repository it pushes exports to. Unset: it commits locally only |
| `THERMITE_RESULTS_KEY_FILE`, `THERMITE_RESULTS_KNOWN_HOSTS` | none | An SSH key and known hosts for the results repository and for fetching private sources |
| `THERMITE_ADVISORS_FILE` | none | The advisors' configuration (teachers, combiner, auditor, review panel). Unset: none run |
