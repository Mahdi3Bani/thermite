---
title: "Advisors file"
description: "Every field of the advisors file that configures a rig's teacher pair, combiner, auditor and review panel, and how Edit rig's models replace it."
type: reference
sidebar:
  order: 4
---

A rig's [supervisor](glossary.md) runs four kinds of **advisors**: models that advise but never judge. The **teacher pair** reviews a running run and recommends directions for its [planner](glossary.md); the **combiner** merges the two reviews into one set of directives; the **auditor** reads a change before it may become the champion; and the **review panel** grades goals that code cannot check. The advisors file is a JSON file that gives each of them a model and sets how they work. The owner can also write to the teacher pair, the auditor and the review panel from a run's **Live**: each reads the messages meant for it and answers there. [Supervision](../explanation/supervision.md) explains why they exist; [Configure advisors](../how-to/operate/advisors.md) gives the steps.

```json title="advisors.json"
{
  "teachers": [
    {
      "name": "teacher-a",
      "runtime": "openai",
      "base_url": "https://llm.example.com/v1",
      "model": "model-a",
      "api_key_file": "/etc/thermite/advisors/llm-key",
      "reasoning": "high",
      "usd_per_mtok_in": 3,
      "usd_per_mtok_out": 15
    },
    {
      "name": "teacher-b",
      "runtime": "cli",
      "argv": ["agent-cli", "--print", "--no-shell", "--no-file-tools"],
      "restricted": true
    }
  ],
  "combiner": {
    "name": "combiner",
    "runtime": "openai",
    "base_url": "https://llm.example.com/v1",
    "model": "model-a",
    "api_key_file": "/etc/thermite/advisors/llm-key",
    "usd_per_mtok_in": 3,
    "usd_per_mtok_out": 15
  },
  "auditor": {
    "name": "auditor",
    "runtime": "openai",
    "base_url": "https://llm.example.com/v1",
    "model": "model-a",
    "api_key_file": "/etc/thermite/advisors/llm-key",
    "reasoning": "high",
    "usd_per_mtok_in": 3,
    "usd_per_mtok_out": 15
  },
  "panel": [
    {
      "name": "reviewer-a",
      "runtime": "openai",
      "base_url": "https://llm.example.com/v1",
      "model": "model-a",
      "api_key_file": "/etc/thermite/advisors/llm-key"
    },
    {
      "name": "reviewer-b",
      "runtime": "openai",
      "base_url": "https://llm.example.com/v1",
      "model": "model-b",
      "api_key_file": "/etc/thermite/advisors/llm-key"
    }
  ],
  "teacher_minutes": 60,
  "fetch_domains": ["arxiv.org", "github.com"],
  "max_usd_per_day": 20,
  "kb": {
    "mcp_url": "https://kb.example.com/mcp",
    "token_file": "/etc/thermite/advisors/kb-token"
  }
}
```

This file gives the rig two teachers (one through an API, one a command-line agent), a combiner, an auditor and a panel of two. The teachers review each running run every hour, may fetch pages from two sites and search a knowledge base. Once the advisors' counted spending for the day reaches USD 20, the supervisor skips them until the next day (UTC).

## How the file is read

- **Where.** The supervisor reads the file named by its setting `THERMITE_ADVISORS_FILE`. Unset or empty, the rig has no advisors file. The local compose stack leaves it empty and mounts the folder `.dev/advisors` at `/etc/thermite/advisors`, read-only, so a file there is `/etc/thermite/advisors/advisors.json` inside the supervisor.
- **When.** Once, when the supervisor starts. A change takes effect after the supervisor restarts.
- **Checks.** The file is parsed with a strict schema. A file that is missing, is not JSON, has a field the schema does not know, or lacks a required field stops the supervisor at start: it logs a `fatal` line and exits with code 1.
- **Edit rig comes first.** A role given a model on the rig's **Edit rig** page uses that model instead of the file's runtimes for that role. See [Models from Edit rig](#models-from-edit-rig).
- **Rigs control sets up.** Rigs that control sets up on a machine, on a cluster or with a join command have no advisors file. Their advisors are the ones **Edit rig** gives.
- **Switches.** The switches **Teacher pair**, **Auditor** and **Review panel** under **Edit rig** › **1 · Parts of the rig** decide whether each role runs at all. **Teacher pair** covers the combiner too. A role that is switched on but has no model, from the file or from **Edit rig**, does nothing.

## Top level

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `teachers` | list of [runtimes](#runtimes), at most 2 | `[]` | The teacher pair: zero, one or two teachers |
| `combiner` | [runtime](#runtimes) | none | Merges the teachers' reviews into one directive set. Without it, the recommendations of the first teacher that gave a review are the set |
| `auditor` | [runtime](#runtimes) | none | Answers open audits |
| `panel` | list of [runtimes](#runtimes), at most 5 | `[]` | The review panel. The harness counts a panel only with at least 2 reviewers with different `name`s |
| `teacher_minutes` | number above 0; fractions allowed | `60` | Minutes between two teacher reviews of the same run |
| `fetch_domains` | list of texts | `[]` | The sites advisors may fetch pages from. A site covers its subdomains. Empty: no fetching. `"*"`: any public site; then no advisor gets the knowledge base, and the auditor gets no fetching at all |
| `max_usd_per_day` | number, 0 or more | none: no limit | A limit on what all the rig's advisors spend in one day (UTC), counted from the `openai` runtimes' prices. See [Spending](#spending) |
| `kb` | object | none | A [knowledge base](glossary.md) the teachers may search, read only: an MCP server of your own that searches your notes or documents |

`kb` has these fields:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mcp_url` | URL | required | An MCP server reached over streamable HTTP |
| `token_file` | path | required | A file with the bearer token for that server. It is read at each search |
| `tool` | text | `"search"` | The MCP tool to call. It is called with `{"query": "<text>"}` |

## Runtimes

Each advisor is one runtime: where and how its model runs. `runtime` chooses one of three kinds. `name` (1 to 60 characters) is required in all three; it names the advisor in the records, and is the auditor's or reviewer's name in the harness.

### `openai`: a model API, run inside the supervisor

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text, 1 to 60 characters | required | The advisor's name |
| `runtime` | `"openai"` | required | |
| `api` | `"openai"`, `"anthropic"` or `"chatgpt"` | `"openai"` | `openai`: an OpenAI-compatible API. `anthropic`: Anthropic's Messages API, whose `base_url` is the address without `/v1`. `chatgpt`: OpenAI's Responses API with a ChatGPT sign-in's access token. The token lasts one hour, and control renews it only for a model from **Edit rig** |
| `base_url` | URL | required | The API's address |
| `model` | text | required | The model's name at that API |
| `api_key_file` | path | none | A file with the API key. It is read at each call |
| `api_key` | text | none | The API key itself. Models from **Edit rig** carry their key this way |
| `reasoning` | `"low"`, `"medium"` or `"high"` | none | The reasoning effort asked of the model. Unset: none is asked for |
| `context_window` | whole number above 0 | `200000` | The model's context window, in tokens |
| `max_tokens` | whole number above 0 | `8192` | The most tokens in one reply |
| `max_turns` | whole number, 1 to 100 | `24` | The most turns in one advisor call. The call ends there; the next round calls again |
| `timeout_s` | whole number, 1 to 7200 | `900` | Seconds one call may take: `timed out after <n> s` |
| `usd_per_mtok_in` | number, 0 or more | `0` | The price per million input tokens, for [spending](#spending) |
| `usd_per_mtok_out` | number, 0 or more | `0` | The price per million output tokens |

With neither `api_key_file` nor `api_key`, every call fails with `advisor <name> has no key`; the supervisor still starts. These advisors can use read-only [tools](#what-each-role-gets).

### `cli`: a command-line agent

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text, 1 to 60 characters | required | The advisor's name |
| `runtime` | `"cli"` | required | |
| `argv` | list of texts, at least one | required | The command and its arguments |
| `restricted` | `true` | required | States that `argv` starts the agent with its own shell and file tools turned off. A `cli` runtime without it stops the supervisor at start |
| `timeout_s` | whole number, 1 to 7200 | `1800` | Seconds before the command and everything it started are ended |

The supervisor runs the command in a new empty folder that is also its home. Its environment holds only `PATH` and `HOME`. The role's instructions and its material go to the command's standard input, ending with `Answer with exactly one JSON object, of this shape (JSON Schema): <schema>.`, where `<schema>` is the [role's answer](#what-each-role-must-answer) as a JSON Schema. The last JSON object the command prints is its answer. An answer wrapped as `{"result": "…"}` is opened once. If no printed object fits the [role's answer](#what-each-role-must-answer), the call fails with `no valid answer:` and the last 300 characters of the command's error output, or of its output when the error output is empty. These advisors get no tools from Thermite, and their spending counts as USD 0.

### `claude-code`: Claude Code with a Claude subscription

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `name` | text, 1 to 60 characters | required | The advisor's name |
| `runtime` | `"claude-code"` | required | |
| `model` | text | required | Claude Code's name for the model |
| `token` | text | required | The subscription's token |
| `effort` | `"low"`, `"medium"`, `"high"`, `"xhigh"` or `"max"` | none | Passed as `--effort` |
| `timeout_s` | whole number, 1 to 7200 | `1800` | Seconds before the call is ended |

The supervisor runs `claude -p --output-format json --model <model> --tools "" --setting-sources "" --strict-mcp-config`, with `--effort` when set: no tools, no settings files and no MCP servers. Its input and its answer work as for a `cli` advisor, the answer's JSON Schema included. The token goes only into Claude Code's environment. The supervisor finds Claude Code through `THERMITE_CLAUDE_BIN`, or else `claude` on its `PATH`; the supervisor image holds Claude Code only when it was built with `CLAUDE_CODE_VERSION`. Its spending counts as USD 0. **Edit rig** can also give a role a Claude subscription: see [Use a Claude subscription](../how-to/models/claude-subscription.md).

## What each role gets

| Role | When it runs | What it reads | Tools (`openai` runtimes only) |
| --- | --- | --- | --- |
| Teachers | For each running run, once every `teacher_minutes`, and at once when the owner has written to the teacher pair, or to all the advisors, since the run's last teacher round started. A round that fails waits the full time too, even one that a message started | The run's brief: the campaign, its champion, the direction families, recent evidence, epochs, the directives in force, and `owner_messages`: the owner's messages to the teacher pair or to all the advisors, each `{id, at, text, answered}`. Up to 5 that the teachers read in the last 24 hours come first, with `"answered": true`; then up to 20 they have not read, with `"answered": false` | `brief`; `fetch_url` when `fetch_domains` is not empty; `kb_search` when `kb` is set and `fetch_domains` has no `"*"`; `answer` |
| Combiner | After the teachers, when at least one gave a review | The brief, the owner's messages included, and each teacher's summary and recommendations. It does not answer the owner | `answer` only |
| Auditor | For each open audit. A failed audit is tried again every 30 minutes, at most 5 times, then left to the owner | The audit's package: the change, its hypothesis and declared flaws, the judge's verdict, why the audit was asked for, and the contract's title, objective, editable paths, `insufficient` and `adversarial_checklist`. Also `owner_messages`: up to 20 of the owner's messages to the auditor or to all the advisors that it has not read, each `{id, at, text}`. In one round, they go with each of the run's audits in turn, until the auditor gives a valid answer to one of them | `fetch_url` only when `fetch_domains` is not empty and has no `"*"`; `answer` |
| Review panel | For each open review, every panelist in turn. Retried as for audits | The goal, its criteria, the contract's `deliverable` and `insufficient`, and the change, without who made it. Also `owner_messages`, as for the auditor: the messages to the review panel or to all the advisors that the panel has not read. Every panelist gets the same ones, and in one round they go with each of the run's reviews in turn, until a panelist answers one of them | `answer` only |

The supervisor starts a round of advisors every `THERMITE_POLL_SECONDS` seconds (60 by default, at least 30) after the last round ends. Between rounds, it looks every 5 seconds for a new message from the owner to the teacher pair, or to all the advisors, in a running run. When it finds one, and the rig has teachers and its **Teacher pair** switch is on, the next round starts at once. That round gives the run its teacher round, even before `teacher_minutes` have passed, unless the day's [spending](#spending) has reached `max_usd_per_day`. A round under way finishes first. One message starts one teacher round: if that round fails, the message waits for the next teacher round on the schedule.

| Tool | What it does |
| --- | --- |
| `brief` | Returns the run's current brief |
| `fetch_url` | Fetches one public web page from the listed sites: `http` and `https` only, no user name or password in the address, no private or local addresses, at most 6 requests a minute to one site, at most 2,000,000 bytes, and `robots.txt` is respected. It returns the address, the title, up to 20,000 characters of text and up to 40 links. Each fetch is kept in the supervisor's home, under `advisor-fetches` |
| `kb_search` | Calls `kb.tool` on the knowledge base with the query |
| `answer` | Gives the final answer. An answer that does not fit the role's schema is returned with its problems, and the advisor may answer again within its `max_turns` |

Each advisor's result is kept as a JSON file under `advisors` in the supervisor's home (`THERMITE_SUPERVISOR_HOME`, by default `/var/lib/thermite-supervisor`).

## What each role must answer

Every answer is one JSON object with exactly these fields. A `cli` or `claude-code` advisor must print it, and is told its shape as a JSON Schema at the end of its input; an `openai` advisor gives it through `answer`, whose parameters are the same schema.

| Role | Answer |
| --- | --- |
| Teacher | `summary`: text, 1 to 4000 characters. `recommendations`: up to 20 directives. `answers`: optional, its [answers to the owner's messages](#answers-to-the-owners-messages) |
| Combiner | `directives`: up to 20 directives |
| Auditor | `decision`: `"clear"`, `"block"` or `"needs_owner"`. `reasons`: text, 1 to 8000 characters. `citations`: up to 20 texts of 1 to 500 characters, default `[]`. `answers`: optional, as for a teacher |
| Review panelist | `pass`: `true` or `false`. `reasons`: text, 1 to 8000 characters. `answers`: optional, as for a teacher |

A directive, in a teacher's recommendations and the combiner's set, has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `"avoid"`, `"try"`, `"mandate"`, `"priority"`, `"lane_count"` or `"note"` | What the planner should do. `note` is text for the planner only |
| `family` | 2 to 41 characters of `a`–`z`, `0`–`9` and `-`, starting with a letter or digit | Optional. The direction family it is about |
| `value` | text up to 1000 characters, or a number | Optional |
| `rationale` | text, 1 to 2000 characters | Why |
| `citations` | up to 20 texts of 1 to 500 characters | Attempt ids from the brief, addresses or paper ids. Default `[]` |

### Answers to the owner's messages

An auditor's answer, with one answer to the owner:

```json
{
  "decision": "clear",
  "reasons": "The change tiles the inner loop. It touches no timing code and no measured input.",
  "citations": [],
  "answers": [
    { "message": 12, "text": "I checked the edge sizes you asked about: the tail loop handles them." }
  ]
}
```

A teacher, the auditor and each panelist may add `answers`: one answer to each of the owner's messages it was given in `owner_messages`, by the message's `id`. Their instructions ask for one or two sentences each, and ask a teacher to answer only the messages marked `"answered": false`. The supervisor drops answers to any other message, and empty ones. The combiner answers none.

| Field | Type | Meaning |
| --- | --- | --- |
| `answers` | list of up to 50 objects | Optional |
| `answers[].message` | a positive whole number, or text that reads as one | The message's `id` |
| `answers[].text` | text, up to 20,000 characters | The answer. It is trimmed and cut to 1,000 characters |

`answers` is lenient, so that it never costs the advisor its review, audit or verdict. When it is missing, has more than 50 items, or any item does not fit, the advisor's whole `answers` is taken as empty.

## What happens to the answers

The supervisor sends every answer to the harness, which checks it again. Nothing an advisor returns can set a verdict, a contract or a champion.

| Role | The supervisor | The harness |
| --- | --- | --- |
| Teachers and combiner | Drops each directive without a citation, and every note after the third. Sends the rest as one set, which replaces the advisors' previous set for that run | Refuses a set with 0 or more than 20 directives, with a directive without a citation (`<n> directive(s) without a citation`), with more than 3 notes (`at most 3 notes per directive set`), or that both avoids a family and asks for it (`the set both avoids and asks for <families>`) |
| Auditor | Sends the decision with the auditor's `name` | `block`: the change is held, and only the owner can overrule it. `needs_owner`: the change waits for the owner. `clear`: the change goes on as the promotion rule says, but it still waits for the owner if it has declared flaws, if its gain is above the contract's absolute trigger, or if the rule is owner approval |
| Review panel | Sends the panel's results only when every panelist answered | Refuses a panel of fewer than 2 (`a panel needs at least 2 reviewers`), a name twice (`each reviewer counts once`), a review of a commit that is no longer the champion, and a run that is not running. The panel passes a goal only if every panelist passes it, and the goal is met only when the owner accepts it |
| The owner's messages | Once a teacher gave a review, the auditor gave a valid answer, or a panelist answered, sends which messages the role was given, with the answers to those messages only. Each teacher's and each panelist's answers are kept under its own name. The audit and the panel's results are sent without the answers. If this call fails, it counts as an error, and the messages stay unread, to be given again | Records that the role read each message, and each answer as an `advisor_answer` event of up to 2,000 characters, with a line in **Live**. Refuses a message that is not in the run (`no message <id> in run <run>`) or not for the role (`message <id> is not for the auditor`). An answer cannot set a verdict, pause a run or reach a worker |

## Models from Edit rig

On a rig's **Edit rig** page, section **2 · The agents**, the owner can choose a model and an effort for the **Teacher pair**, the **Combiner**, the **Auditor** and the **Review panel**. Each choice replaces the file's runtimes for that role only. The empty choice, **the rig's advisors file**, leaves the role to the file. See [Give each agent its own model](../how-to/models/model-per-agent.md).

| Role on Edit rig | Becomes |
| --- | --- |
| **Teacher pair** | Two runtimes, `teacher-1` and `teacher-2`, with the same model |
| **Combiner** | One runtime, `combiner` |
| **Auditor** | One runtime, `auditor` |
| **Review panel** | Three runtimes, `reviewer-1`, `reviewer-2` and `reviewer-3`, with the same model |

| Provider of the model | Runtime | Its fields |
| --- | --- | --- |
| A Claude subscription | `claude-code` | The effort as chosen; `timeout_s` 1800 |
| An OpenAI-compatible, Anthropic or ChatGPT provider | `openai`, with `api` set to the provider's type | The provider's address and key; the effort as `reasoning`, with `xhigh` and `max` sent as `high`; the provider's context window, or 200000; `max_tokens` 8192; `max_turns` 24; `timeout_s` 900; both prices 0 |
| OpenCode's own models | None: advisors do not run OpenCode | The role keeps the file's runtimes |

The **Runs in** column says where each role runs: `Claude Code, no tools`; `the supervisor, read-only tools`; `not for advisors: OpenCode only`; or `the advisors file, if the rig has one`.

- The supervisor asks control for these models (`GET /v1/rigs/<rig>/advisor-routes`) before every round, so a change takes effect without a restart.
- When control cannot be reached, the models it gave last stay in use.
- All other fields come from the file: `teacher_minutes`, `fetch_domains`, `max_usd_per_day` and `kb`. With no file, they keep their defaults: every 60 minutes, no fetching, no spending limit and no knowledge base.

## Spending

- Each call of an `openai` runtime costs `(input tokens × usd_per_mtok_in + output tokens × usd_per_mtok_out) ÷ 1,000,000` US dollars. `cli` and `claude-code` calls count USD 0, and so do models from **Edit rig**, whose prices are 0.
- The supervisor adds up the day's spending (UTC) in `advise-state.json` in its home, so the total survives a restart.
- With `max_usd_per_day` set, the supervisor checks the total before each role's turn in a round, and skips the role once the total has reached the limit, until the next day. A round that has started can go past the limit.
- Without `max_usd_per_day`, there is no limit.

The rig's page on the dashboard shows, in its **Advisors** row, the teacher rounds, directive sets, audits, errors and US dollars spent.

## A round in Live

Each step of a round is a line in the run's **Live**, under **Advisors**, and in the rig's own live view (the **Live** button on the rig's page), under **Supervisor**. [Steer a run](../how-to/campaigns/steer-a-run.md) shows how to open Live.

| Line | When |
| --- | --- |
| `the teacher pair reviews <run>` | A teacher round of the run starts |
| `the teacher pair reviews <run> now: the owner wrote to it` | A teacher round that a message from the owner started |
| `teacher <name>: <summary> Suggests: <kind> <family>, ….` | A teacher's review: its summary, cut to 400 characters, and the kind and family of each recommendation |
| `teacher <name> gave no review: <error>` | A teacher failed |
| `the teacher pair read the owner's message #<id>: <text>` | The harness recorded that the teachers read one of the owner's messages, once a teacher gave a review with it in the brief. The text is cut to 300 characters. Live shows "✓ the teacher pair read your message: “…”". The auditor and the review panel have the same line, once they answered |
| `the teacher pair (<name>) answered the owner's message #<id>: <text>` | An answer. Live shows "**the teacher pair (teacher-a) answered you:** …". The auditor's and the panelists' answers read the same way |
| `directives for the planner: <kind> <family> <value> (why: <rationale>); …` | The directive set sent to the harness. `. Dropped: …` names the directives dropped for having no citation, and the notes after the third |
| `the teacher pair set no directives` | The round gave no directive |
| `audit of <attempt> (try <n>): <decision>, <effect>. <reasons>` | The auditor answered. `<effect>` is what the harness did, such as `promoted`, `blocked`, `waiting for the owner` or `none: the attempt is <state>` |
| `review <id> of goal <goal>, <name>: pass. <reasons>` | One panelist's answer: `pass` or `fail` |
| `review <id>: the panel passed it; it waits for the owner's acceptance` | Every panelist answered, and the panel passed the goal. Otherwise the line is `review <id>: the panel did not pass it` |
| `<what failed>: <error>` | An error, such as `teachers for <run>: no teacher produced a review`. See [Error messages](#error-messages) |
| `advisor round done: <n> teacher runs, <n> directive sets, <n> audits, <n> reviews, <n> errors` | The end of a round that did at least one of these. It names no run, so the Live of every run on the rig shows it |
| `advisor round failed: <error>` | The round itself failed |

## Error messages

Each failed teacher round, audit and review, and each failed report of the owner's messages, is counted as an error on the rig's **Advisors** row and logged by the supervisor as `advisor error` with its message. It is also a line in the run's **Live**, which starts with what failed: `teachers for <run>:`, `audit of <attempt>:`, `review <id>:` or `the owner's messages to the <role> for <run>:`.

| Message | Meaning |
| --- | --- |
| `advisor <name> has no key` | An `openai` runtime has neither `api_key_file` nor `api_key` |
| `timed out after <n> s` | An `openai` call took longer than its `timeout_s` |
| `no answer` | An `openai` advisor ended without calling `answer` |
| `no valid answer: <output>` | A `cli` or `claude-code` advisor printed no object that fits its role's answer |
| `no teacher produced a review` | Every teacher failed in this round |
| `the combiner gave no directive set: <why>` | The combiner failed |
| `<k> of <n> panelists answered` | A panelist failed, so the review is tried again later |
| `the owner's messages to the <role> for <run>: <error>` | The supervisor could not tell the harness which of the owner's messages the `teachers`, the `auditor` or the `panel` read, or their answers. The messages stay unread and are given again |
