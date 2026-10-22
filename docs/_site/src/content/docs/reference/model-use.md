---
title: "Model use and cost"
description: "Every part of the dashboard's model use and cost: the top of a run's page, a campaign page's sidebar, the Metrics page, and each model's price in Settings › Providers."
type: reference
sidebar:
  order: 22
---

The dashboard shows what the agents' model calls used and cost in four places:

- **A run's page**, at the top, above its tabs, so it shows on every tab: the run's [model use](glossary.md), by agent and model.
- **A campaign's page**, in its sidebar: the same, summed over all its runs on every rig, with each run.
- **Metrics**, in the main navigation after **Rigs** (address `/ui/metrics`): the whole system's, by model and by campaign, for today, the last 7 days or all.
- **Settings › Providers**: each model's price, which the cost uses.

Code counts every call where it is made, never an agent ([The model usage records](../explanation/how-it-fits-together.md#the-model-usage-records)). Control sums the records when a page is drawn. The REST route [`GET /v1/usage`](rest-api.md#model-usage) and the MCP tool [`model_usage`](mcp-tools.md#model_usage) give the same numbers. Every label and column with an **i** says what its number means when you hover it.

## The words

| Word | Where | What it means |
| --- | --- | --- |
| `not reported` | Any figure | The harness that ran the calls does not give that figure, so it is not counted. It is never shown as 0 |
| `on a plan` | Cost | The calls ran on a subscription: a Claude or ChatGPT provider, or Claude Code. Their tokens are counted, not priced |
| `no price` | Cost | No price is known for the model: its provider's list gives none and you set none. Never $0 |
| `free` | Cost | The provider's list gives the model a price of 0 |
| `<$0.01` | Cost | Less than half a cent, but more than nothing |

A cost with an **i** before it leaves something out or adds something. Its **i** says what: the GPU time on RunPod in it, the tokens on a plan or with no price that are not in it, the free tokens, and the tokens in that were priced as not cached because their harness does not report the cache (OpenCode v2, for example).

## The six numbers

The run's top and Metrics start with six tiles.

| Tile | What it shows |
| --- | --- |
| **Cost** | The dollars, split by a bar into tokens in (not cached), cached in, out, and **GPU time on RunPod**. Under it, the tokens with no dollars: `144k tokens on a plan · 350k no price · 3.3k free` |
| **Tokens in** | Every token sent to the models, split into `cached` (the provider read them from its cache), `not cached`, and `not reported by` the harnesses that do not say |
| **Tokens out** | Every token the models wrote, with the reasoning tokens under it where the provider counts them |
| **Calls** | The model calls. Records that do not say how many calls they cover (a Codex turn) count as none, and an **i** says how many there are. The bars under it count the calls: in each round for a run; in each hour of today, or on each day, for Metrics (each week, past 62 days) |
| **Output speed** | Tokens out a second, from the first token to the last of each call: the median, with `p10–p90` under it (8 of 10 calls are in this range) |
| **Time in calls** | All calls added together, from the request to the last token, with the median time to the first token under it |

A run's **Calls** tile also says how many calls the workers made in a trial, such as `28 a trial`.

## A run's page

The block is called **Model use**. Its line on the right counts the run's trials and rounds: `48 trials · 16 rounds`. A run that has made no model call yet says `No model call recorded yet. Code counts each call of the agents when it ends.` A try of a kit, which has no agents, shows no block.

Under the six numbers, **By agent and model** has one row for each agent's calls to each model, in two groups, as [Edit rig](../how-to/models/model-per-agent.md) names them:

- **The work**: **Workers**, then the **Planner**.
- **The advisors**: **Teachers** (with `teacher 1` or `teacher 2` under it when the run has two teachers and the rig's settings say which model is which, and `merged by` for the model that merges their advice), the **Auditor** and the **Review panel**.
- **The rig**: on a rig launched on RunPod, the row **GPU time on RunPod**: the pod's spend while this run was at work, with its time at the pod's price an hour, such as `5 h 36 m at $1.65/h`.

| Column | What it shows |
| --- | --- |
| **Agent** | The agent, and the line under it |
| **Model** | The model, with the harness that ran it and the provider that served it under it: `Pi · my-litellm` |
| **Calls** | Its calls |
| **In** | Its tokens in |
| **Cached** | Its tokens in that the provider read from its cache |
| **Not cached** | Its tokens in that the provider read again |
| **Out** | Its tokens out, with reasoning |
| **tok/s** | The median of its calls' output speed, with p10–p90 under it |
| **Cost** | Its tokens at the model's price, or one of [the words](#the-words) |
| **Share** | Its tokens in and out, as a part of the run's |

On a narrow screen the table keeps **Agent**, **In**, **Cached**, **Out**, **tok/s** and **Cost**, and shows the model under the agent.

## A campaign's page

The campaign's sidebar has its own **Model use**, over all its runs on every rig. Its line on the right counts the runs with records.

- **Cost**, as on the run's top.
- **Tokens in**, with the part that was cached under it. Where a harness does not report the cache, the part is of the tokens that were reported, and an **i** says how many were not.
- **Tokens out**, with the reasoning tokens.
- **Calls**, with the time in calls under it.
- **Output speed**, with the median time to the first token.
- A table of its runs: **Run** (a link to the run's page, with `at work`, `paused` or `finished` and its rig), **In**, **Out** and **Cost**. A run's cost includes its pod's spend on RunPod.
- **By model, on Metrics ›** opens Metrics.

## Metrics

**Metrics** shows the model use of every campaign and rig. The chips **Today**, **7 days** and **All** choose the period; **7 days** is the default. They are links, such as `/ui/metrics?period=today`.

- **Today** starts at midnight in your own time zone. The page's script adds your browser's zone to the address (`tz`, such as `tz=Europe/Paris`); without the script, today starts at midnight UTC. The line under the title says which zone the page uses: `every campaign and rig · times in Europe/Paris`.
- **7 days** is the 7 days up to now.
- **All** is every record.

Under the six numbers:

- **By model**: one row for each provider's model, with its provider and every harness that ran it under it (`my-litellm · Pi, OpenCode v2`), its **Calls**, **In**, **Out**, **Cached** (the part of tokens in), **tok/s**, **Cost** and **Share**. When a RunPod pod spent in the period, the last row is **GPU time on RunPod**, with the pods' rigs. On Metrics it includes the time no run was at work, which no campaign counts.
- **By campaign**: one row for each campaign, with its mode, its **Runs**, then the same columns. A run that control has no campaign for is `no campaign`.

## Prices in Settings › Providers

Open a provider's row in **Settings › Providers**. Under its models, **Prices, $ for a million tokens** lists each model with three fields: **In** (tokens in not read from the cache), **Cached in** (tokens in read from the cache; empty: the **In** price) and **Out** (tokens out, with reasoning). Under the model's name, a chip says where its price comes from:

| Chip | Meaning |
| --- | --- |
| `from the provider` | The provider's model list gives the price. Control keeps it up to date with the list, and its fields can't be changed |
| `free, from the provider` | The list gives a price of 0 |
| `yours` | You set it here, or with [`POST /v1/model-prices`](rest-api.md#model-usage) or [`set_model_price`](mcp-tools.md#set_model_price) |
| `no price` | Neither: the model's calls show `no price` |

The line under each model says what its calls so far cost at the price in its fields, such as `So far: 41.6M in, 846k out · $34.55`, and changes as you type. **Save prices** waits until a price changes. To set a price, fill in **In** and **Out**; to remove yours, empty all three. The block then says `Saved. Every cost follows.`: a price you set or change costs every call of the model, the earlier ones too. Each change is in the audit log as `model_price_set` or `model_price_cleared`, by `owner:ui`.

The page says why a price is not saved, before and after **Save prices**:

| Message | Why |
| --- | --- |
| `A price is a number, such as 0.60.` | A field holds something other than a number of US dollars |
| `Set In and Out, or leave all three empty.` | Only one of **In** and **Out** is set, or **Cached in** without **In** |

A provider whose list gives only free models shows `free, from the provider's list.` instead of the fields. A Claude or ChatGPT subscription has no price: its row says `On a plan: its calls show their tokens, and “on a plan” for cost.`
