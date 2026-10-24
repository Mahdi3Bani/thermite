---
title: "Campaign modes"
description: "Hill climbing, goal campaigns and research campaigns: how each one works and what ends it."
type: explanation
sidebar:
  order: 3
---

A **campaign** is one piece of research: what to improve, reach or find out, and how to judge it. Thermite runs three kinds, called **modes**. This page explains how each mode works, what ends it, and how to choose one.

| | Hill climb | Goal | Research |
| --- | --- | --- | --- |
| The question | How far can this number go without breaking anything else? | Can the project reach these goals? | What can be learned about this question in this time? |
| An agent's work | One change to the code, and any sources, claims and notes it records on the way | One change to the code, and any sources, claims and notes it records on the way | Reading sources and recording claims, with quotes, and findings |
| What checks it | The judge, by timing the change against the champion with statistics | The judge, by each goal's own test; the review panel passes goals that need judgement (and you, when the run asks you) | Code that finds every quote, word for word, in a page the rig archived, and checks each finding against verified claims; the review panel decides when the questions are answered, and code checks its answers the same way |
| The best result | The champion: the best confirmed version | The champion: the version that meets the most goals | The findings, the verified claims and the report |
| It ends when | Never on its own: you pause it | Every required goal is met, or the evidence shows that they cannot be (where the contract allows it; you decide, if the run asks you) | After its minimum duration, the review panel finds every question answered (you decide, if the run asks you), or its maximum duration is over |
| The dashboard's headline | The best gain over the starting point | Goals met | Verified claims |

## What every mode shares

Each campaign has a **contract**: a file that says what the campaign must achieve, what must not get worse and which files the agents may change. A contract has a version number; a changed contract is a new version, never an edit of a running one. A **run** is the campaign on one rig, and one campaign can have runs on several rigs. [Write a contract](../how-to/campaigns/write-a-contract.md) and the [contract reference](../reference/contract.md) cover every field.

In every mode, **code decides when a campaign is done, never an agent.** No agent can close a run, mark a goal met or end the research early. The owner can close a run by hand, in any mode, when they no longer want it: it ends for good ([Steer a run](../how-to/campaigns/steer-a-run.md#close-a-run)).

Nothing ends a campaign by default. There is no limit on turns, attempts, failures or time unless you set one. The contract can set three **budgets**: hours since the run was created (paused time counts too), hours of judging on the device, and money spent on the model (counted only when the rig is told the model's prices). A spent budget **pauses** the run; it never closes it. The **Stop after (hours)** field on the New campaign page sets the first. [Set a budget or a stop time](../how-to/campaigns/budget-and-stop-time.md) explains all three, and [Why Thermite runs until the job is done](runs-until-done.md) explains why there are no defaults.

A rig works on one run at a time. Starting or resuming a run on a rig pauses the run that was running there; a paused run can be resumed later.

### Research in every mode

Reading is not only for research campaigns. A change to code often rests on something read: a paper, upstream code, an issue or a specification. So workers in hill-climb and goal runs can fetch web pages through the rig's archiving fetcher, read and search what the run archived, and record a claim with its exact quotes or a research note with the sources it rests on. Code checks their claims as it checks a research run's ([Research](#research)). Findings, hypotheses and report sections stay with research runs: a hill-climb or goal run refuses them.

Such a run's research folder holds `INDEX.md`, `sources/`, `claims/` and `notes/`, which the harness writes from the run's records and keeps current, `knowledge/`, the past research described below, and `compactions/` once a trial's conversation was [compacted](../reference/limits-and-pacing.md#compaction). Once the run has recorded anything there, each worker's brief points to the folder, and tells the worker to search it before fetching a page again. The fetcher uses fixed values in these runs: it respects `robots.txt`, and fetches at most 6 pages a minute from each site and at most 5,000,000 bytes a page. In Pi, the worker has the tools `fetch`, `read_source`, `search_corpus`, `add_claim` and `add_note`; in OpenCode, Claude Code and Codex, the same five as `thermite-trial research` commands.

### The campaign's brief

In every mode, a campaign can carry its author's **brief**: additional information in Markdown (the project and its links, what was tried, limits, what good looks like), starting links, ideas to try (hill climb and goal) and hypotheses. It is part of the contract. The planner (in a hill climb or goal campaign) and the advisors read it whole, each worker reads it in its brief, and the run's folder keeps it as `BRIEF.md`. The agents weigh it as starting points, not rules: the objective, the judge and the owner's messages decide. [The campaign's brief](../reference/contract.md#the-campaigns-brief) lists what each agent gets.

### Field notes and past research

In every mode, the workers, the planner (where the run has one) and the advisors keep **field notes** as they work: short notes of what they observed, decided and learned, which the run's **Journal** tab shows. Every run's records also go into its campaign's folder in **Thermite's knowledge base** on control. Later runs of the campaign read that folder, and other campaigns' folders when the owner grants them, in their research folder's `knowledge/`. [Journals and the knowledge base](journals-and-knowledge.md) explains both.

## Hill climb

A hill climb pushes one number, the **primary metric**, up or down: operations per second, run time, a score that the kit's check reports. The contract says which way is better and the smallest gain that counts. It can also name:

- **guards:** other metrics that must not get worse, each with how far it may slip in one step and in total against the starting point's measured values, so a faster change that loses quality is not a win;
- **hard constraints:** pass-or-fail limits, such as a longest allowed run time;
- **test cases** that the judge measures every time, and **hidden test cases** that it runs only to confirm a change that already looks better. The kit and the contract call a test case a **cell**; the dashboard calls it a **case**.

**Where it starts.** A hill climb's first job is its **baseline**. Before any change is judged, the judge builds the starting point and times it alone on every test case, in three blocks, and records each case's value of the primary metric, of every guard and of the kit's other metrics, with their spread. No round of work is planned and no trial starts until it has done so. Everything after is held against those values: a guard's total allowance holds against what the starting point measured, not only against the sum of each step's estimate. During the baseline, the kit's check may keep files, such as reference outputs, in a folder only the judge can reach; every later check reads them and cannot change them. The run's page shows the baseline under **Where the run started**.

**A starting point that can't be measured yet.** When the starting point does not build, crashes on a case, fails the kit's check or gives an impossible value, the run is in **setup**. Its rounds are setup rounds: each worker's brief gives the judge's reasons, and asks for a change within the editable paths, never the kit, that makes the project build and run every case. A project that starts from nothing begins this way. The judge checks each such change with its baseline job, as it checked the starting point. The first change it can measure becomes the starting point, as a new champion, and its values the baseline; the gain counts from there. A change it can't measure gets its verdict, with the reasons, and the lane tries again. Agents never judge: the judge's baseline job decides, and the kit stays the judge's.

**How a change is judged.** The judge builds the change and checks that it works on every test case. Then it times the change and the champion together, in blocks that alternate between the two on the same device, and decides with statistics set in the contract. A change that looks better is timed again in fresh blocks and run on the hidden test cases. After the baseline, and then once a day when it has nothing else to do, the judge times the champion against itself to learn how noisy the rig is, and uses that in every later decision. [Why agents never judge](why-agents-never-judge.md) follows a change through every step.

**Who promotes.** Hands-off by default: a confirmed win becomes the new champion with no step of the owner's. On a rig with an auditor, a surprisingly large gain first goes to an **audit**: by default, a gain above 15%, or above three times the median of the run's earlier confirmed gains once it has three. So does a change whose agent declared known flaws. The auditor's clear is the last step; its block stops the change, with its reasons; anything it hands on waits for the owner. A run waits for the owner only where it was set to ask: every promotion, a gain above a line, or declared flaws. [Decide what waits for you](../how-to/campaigns/decide-what-waits.md) shows how to choose.

**When it ends.** Never on its own. A faster program can always be tried, so no code closes a hill climb. It stops when you pause it, when a budget you set pauses it, or when another run starts on its rig, and ends when you close it. Its champion is ready to download at any time.

## Goal

A goal campaign works until a list of goals is met. Each goal has its own test, which the contract names:

- **a code test:** a set of the kit's test cases, called a **verifier**, that must all pass the kit's check. A kit can order its verifiers and run an expensive one only after the cheap ones it depends on have passed;
- **a metric threshold:** a number, such as items per second, that must be above or below a value. The judge runs each test case several times (five by default) and counts the goal as met only when the whole uncertainty range is on the passing side;
- **a review:** a goal that needs judgement, such as the quality of documentation. The rig's review panel, a group of models, reviews the champion's change without knowing who wrote it, and needs at least two reviewers who all pass it (two to five in the advisors file, three on one model when its model comes from control: **Edit rig**, MCP or the REST API). Their pass meets the goal, unless the run asks the owner to accept it.

The contract also says what the finished work must be, and can list results that do **not** count, such as a special case that only passes the tests. That list goes to the auditor and the reviewers; code does not check it.

**What counts as progress.** A change makes progress when it meets a goal that the champion does not, and loses none that the champion meets. A change that could not check a goal the champion meets is not counted as worse, but not as progress either: its verdict is `inconclusive`. A change that makes progress is checked again in fresh runs, and on hidden test cases for the goals it gained, before it is promoted. If the contract has an adversarial checklist, a list of ways a change could fake success for the auditor to look for, every promotion is audited first.

**How each goal is checked.** The contract's words for a goal can drift from what the kit really runs. So the dashboard shows each goal's real check: folded under **How it is checked** below each goal in the run's **Goals** block (and in a campaign's **Goals** block before its first run), and under **How each goal is checked** on a campaign's page once it has runs: the kit's verifier or the metric threshold, the cases it runs on with the parameters the kit runs each with, each case's time limit, and the hidden test cases by name only. It comes from the kit as the run's rig reported it when the run started; for a campaign's page, from the kit control keeps when it keeps one, else from the newest run's rig report. When there is none of these, it shows what the contract says, and says why the rest is missing. `get_run` and `GET /v1/rigs/<rig>/view` give the same as each run's `goal_checks`.

**The goal report.** When the run starts, and after each promotion, the judge checks every goal on the champion. The planner and the workers see that report, so they know which goals are still open, and the next round of work waits for it, for up to two hours. For each goal checked by code, met or not, it gives what the judge measured on each test case: a metric threshold's mean and range, and a kit verifier's metrics, such as a quality ratio. So everyone sees how far an open goal is from its line, and how much room a met one leaves. A hidden test case's values are never in it. The run's **Goals** block shows them under each goal; [The goal report](../reference/verdicts.md#the-goal-report) gives the details.

**When it ends.** In one of two ways:

- **Every required goal is met**, or, if the contract says so, at least a set number of them. Because this ending is final, the judge checks the champion twice, independently, and closes the run only if both checks agree. The second check also runs the hidden test cases of every goal the champion meets: a change is checked on hidden cases only for the goals it gained, so a goal met long before would otherwise never meet them. While the second check waits or runs, no new trial starts: its work would be lost when the run closes. A trial already at work goes on, and if the second check does not agree, or a hidden case fails, the lanes go on too. A goal whose hidden case failed counts as not met, so the lanes work on it again; they learn which goal and how its hidden check failed, never which case.
- **The evidence shows that the goals cannot be met.** Thermite proposes this ending, called **"not possible"**, only when the contract allows it, and only with evidence: a number of different approaches, set in the contract, each tried at least three times with no progress. Those approaches are then set aside. By default the proposal closes the run. A run that asks you about it waits for you to accept it, which closes the run, or reject it, which reopens them; a new proposal then needs more failed approaches than the last one. No agent can propose it.

A goal campaign has no time limit of its own. Budgets pause it, as in any mode.

[Your first goal campaign](../tutorials/first-goal-campaign.md) runs one from start to finish.

## Research

A research campaign studies a topic until its questions are answered. The contract gives the topic, the questions and which web sites to include or leave out. A question can be as long as it needs, with several lines; every research worker's brief has each one whole. The brief adds the background, the starting links (the contract's `seeds`) and the author's hypotheses. The harness fetches and archives the starting links when the run starts, while the first trials run, and the run starts with those hypotheses as its own, so its workers look for sources for and against them. There is no project to change and no kit: the work is reading.

**How the work is checked.** Workers fetch pages through the rig's archiving fetcher, which keeps a copy of everything it reads. By default it respects `robots.txt`. It limits how fast it fetches from each site and how large a page may be, and never fetches private or local addresses. A page a worker reads any other way verifies nothing until it is fetched through the archiving fetcher. A worker records a **claim** with exact quotes from those archived pages. Code then checks it:

- a claim is **verified** only if every quote appears word for word in the archived text, and every number in the claim appears in its quotes. Otherwise it stays a draft, with its problems listed. The same claim sent again with the same quotes is not recorded twice: the worker gets the earlier claim and its problems back, with a note to copy the words exactly or to record a note instead;
- each quote names its source by the id that the fetch gave it, such as `s-3f2a9c41d0b7`. A worker may also name it by the page's address, when that page was archived, or by its file name in the research folder (`sources/s-3f2a9c41d0b7.txt`). When that names exactly one archived source, the quote is checked against that source's text, as by its id, and the claim keeps both the id and what the worker wrote. When it names none or several, the problem says what the source could be: `fetch it first`, the ids an address was archived as, or an archived address written another way, such as `http` for `https`;
- a number from a heading or a label in the claim's text, such as `Question 0:` or `# Claim c-005`, counts like any other number. Its problem says that it comes from that heading, and that a question's number goes in the claim's `question` field;
- a verified claim whose quotes come from at least two different web sites counts as independently sourced. The contract can ask for more sites. The report lists these claims apart from those that rest on one site.

The run's **History** tab has a line for each claim: `lane-1 recorded a verified claim: "…".`, or `lane-1's claim stays a draft: "…". Why: …`, with the first three problems, in the words the worker got back.

When verified claims together show something, a worker records a **finding**: the conclusion in one sentence, a summary, why it matters, and the verified claims behind it. Code checks a finding too. It counts only if every claim it cites is verified and every number in it appears in those claims. Otherwise it stays a **draft finding**, with its problems listed. A finding is kept once: the same conclusion sent again gets the finding already recorded. A draft sent again with the same problems is not recorded again: the worker gets the earlier draft and its problems back, with a note to cite only verified claims and their numbers, or to record a note instead. The report gives each finding with its support, and says how many of its claims are independently sourced.

Workers can also write research notes, propose hypotheses that cite verified claims, and draft report sections. The report shows those sections as worker sections, never as findings, and flags any number in them that is in no archived source and no verified claim.

On the run's **Overview** tab, the block **Research questions** shows the newest digest or final report: each question by its number and words (the full words on hover), with its count of verified claims and a bar measured against the question with the most. Below them, **Answer check** says in one line where the check that ends the run stands ([When it ends](#when-a-research-run-ends)), including when the final writer is writing the run's paper and when the paper is in. Once the paper is in, a **Research paper** line says who wrote it, whether the rig's STE checker checked it and how many next experiments went to the knowledge base, with a link to `paper.md`, and **Research paper** opens the paper beside **Latest report**. A line counts the numbers in the latest report that appear in no archived source and no verified claim, such as `3 numbers in the latest report appear in no archived source and no verified claim. The report flags each one.`, and **Latest report** opens the report.

**The research folder.** Each run has a folder of files that its workers search and add to. The harness writes most of it from its records and keeps it current while the workers record. The workers can read what the harness writes and the lanes' saved files, and change only their own lane's working area:

```text
INDEX.md          the questions, what is known so far, and where everything is
REPORT.md         the newest report
paper.md          the research paper, once code accepted it, with its references
BRIEF.md          the campaign's brief from its author, when it has one
sources/          every archived page as text: the words a claim's quotes must match
claims/ findings/ hypotheses/ notes/ report/
                  every claim (verified or draft), finding, hypothesis, note and report section
lanes/<lane>/     each lane's files, as they were when its last trial ended
work/<lane>/      the lane's working area: syntheses, outlines, drafts, lists of what to read next
compactions/      each agent conversation the harness kept whole before each compaction
knowledge/        past research from the folders the campaign may read; its README.md says what is where
```

A lane's working area is kept for its next trial, so a worker builds on what the trials before it learned. When a trial ends, the harness saves the lane's files, records which trial wrote or removed each one and when, and shows them to the other lanes under `lanes/`. These files are working material, not results: only claims and findings recorded through the research tools are checked and reported.

**What a worker has.** It depends on the rig's [worker harness](../reference/glossary.md), the program the agents run in:

- **In Pi**, a worker has the research tools (fetch, read an archived source, search the archive, record a claim, a note, a hypothesis or a finding, write a report section, and see the progress) and file tools: list, read and search the folder, and write and remove files in its own working area. It has no shell. Its `idea` tool proposes another research task for the queue, and its `note` tool writes a field note.
- **In OpenCode v2**, a worker keeps OpenCode's own tools, including its shell and files, as a hill-climb worker does. It starts in its lane's working area and runs the research tools as `thermite-trial research` commands, proposes another task with `thermite-trial idea`, and writes a field note with `thermite-trial note`.

A Claude subscription runs only in Claude Code, which doesn't run research workers, so a research campaign needs another model. On a rig whose workers run in Codex, research workers run in Pi, with the same model. OpenCode's own free models work only when the agents run in OpenCode v2. A research campaign needs a model to do anything at all.

**How the work is planned.** Research is planned by fixed rules, not by a model. Each research task is an experiment in the run's [experiment queue](agents-lanes-planner.md#the-experiment-queue): a kind of task (explore, find primary sources, look for contradictions, or consolidate) for one of the campaign's questions. Its rounds are research rounds: the run's agent figures count them apart from a planner's rounds, never as fallbacks. Each round, when the queue holds fewer tasks than the run has **lanes** (lines of search, each with one worker), the research plan adds tasks: the questions with the least coverage first. When an hour passes with no new source and no newly verified claim, primary sources and contradictions come first. Each lane then takes the next task in the queue, whoever added it, so the owner and the teachers can add tasks too. The teachers read what the run has found before they propose tasks: the sources, the claims with the harness's reasons for each draft, the hypotheses, findings and notes, the report and the lanes' files ([What the teachers read](supervision.md#what-they-read)). A worker's idea for another task waits until the owner queues it or drops it, because no model plans a research run. The report shows what was new in the last hour. The owner can message the lanes, the teachers and the review panel of a research run, but it has no planner or auditor to message ([How the parts fit together](how-it-fits-together.md#the-owners-messages)).

**What it produces.** The final report and the whole research folder: the archived sources, every claim, finding, hypothesis and note, and the lanes' files. A digest of the report comes every hour by default, with a line that says where the answer check stands. When the review panel found every question answered, the final report starts with the run's [research paper](#the-research-paper), when the final writer's paper passed the harness's checks. Then, as an appendix, come **Answers**: each question's answer from the review panel, the claims it cites and how many reviewers found it answered; **Hypotheses: the review panel's verdicts**: each hypothesis supported, refuted or undecided, and how the reviewers differ when they do; and the corpus. An answered run without a paper says why in its final report, such as `Research paper: none, no final writer on this rig.` A final report without a pass says that the questions were not checked as answered, and why. The rig's export after the final report carries the folder, without `knowledge/`, and every export carries the run's field notes and research notes ([Set up the results repository](../how-to/operate/results-repository.md#what-gets-pushed) says what reaches the repository).

**Web search.** Research workers search the web through an MCP server the campaign gives them ([Give agents MCP tools](../how-to/campaigns/give-agents-mcp-tools.md)). Without one, they start from the campaign's starting links and follow the links of pages already archived.

Some things are not built yet:

- A model planner for research ([goal 047](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/047-research-planner.goal)).

### When a research run ends

The minimum duration (`min_duration`) is the time a run has to collect sources and claims. After it, the run ends when its questions are answered. No worker decides that: code checks the evidence first, and the supervisor's [review panel](supervision.md#the-review-panel) decides.

1. **Code checks the evidence.** At each digest (every `report_cadence.digest_minutes`, an hour by default) after the minimum, the harness asks the review panel only when every question has at least one verified claim; when the run has the campaign's floor of verified claims, if it sets one (`min_verified_claims`, **Verified claims before the check** on the **New campaign** page); when no review of the run waits; and when the run found new verified claims or findings since its last review. A review that found gaps is never asked again on the same evidence.
2. **The review panel answers.** Each reviewer gets the topic, each question with its verified claims (their words, their sources' sites and whether they are independently sourced), the run's findings and each hypothesis with the claims cited for it, and nothing about which lane or model found what. For each question, a reviewer says whether it is answered, gives an answer that cites verified claims, or says what is missing. A research run measures nothing, and the reviewers, the teachers and the workers are all told so: its evidence is what archived sources say, and nothing its workers run counts. So a question is answered when its claims give the best answer that sources allow. What only a measurement could settle, such as a test on the hardware the question is about or a benchmark, is named in the answer as a next experiment, for a goal or hill-climb run to take, and never counted as missing. Workers record such an experiment in a report section or a note and propose no measurement for the queue, and teachers propose none either. For each hypothesis, it gives a verdict: supported, refuted or undecided, with why and the claims it rests on.
3. **Code checks each answer.** Every claim an answer cites must be a verified claim of the run, and every number in the answer must be in those claims, as for a finding. An answer that fails counts as not answered, with the reason. A supported or refuted verdict needs at least one cited claim; an undecided one needs its reason.
4. **The decision.** The review passes only when every reviewer, at least two, found every question answered and gave every hypothesis a verdict. A pass is taken at once, unless the run asks you about reviews (**Ask me first about** reviews): then it waits in **Needs you** with the answers ([Decide what waits for you](../how-to/campaigns/decide-what-waits.md)).

On a pass, no new trial starts, and the run waits for its [research paper](#the-research-paper). Once the paper is in and the trials still running finish, the run writes its final report, with the paper first and the answers and verdicts after it, and closes with the reason `every question is answered`. On a rig with no final writer, it does not wait: once its trials finish, it closes with the answers and verdicts, and its final report says `Research paper: none, no final writer on this rig.` Its page then reads **Completed**. When the review panel finds gaps, what each reviewer found missing goes in the run's journal and in the next workers' briefs, and the run goes on; it is checked again at a later digest, on new evidence. When you reject a pass, the run goes on too, and your note goes in its journal.

The maximum duration (`max_duration`) still ends a run when its time is up, answered or not: the trials still running finish, the final report is written and the run is closed. Without a pass and without a maximum, it runs until you close it. Only time the agents could work counts: time spent paused does not, and neither does time the agents were stopped by the model provider (no credits, a refused key, no model call that worked for 30 minutes, a failing model check) or waited for its rate limit.

A rig whose supervisor has no review panel, or whose review panel is off (**Edit rig**), keeps researching: the run's **Answer check** says that its check waits for a review panel.

### The research paper

When the review panel's pass is accepted, the harness asks the supervisor's **final writer** for the run's research paper. The final writer is an advisor: it uses the model of the rig's first teacher, so a rig whose teachers are set up and switched on (**Edit rig**) has one ([Configure advisors](../how-to/operate/advisors.md#the-final-writer)). Until the supervisor says whether it has one (it says so every minute), the run waits. Its brief has the review panel's checked answers and verdicts, the campaign's brief, the questions and hypotheses, and the run's figures: its counts of sources, sites, claims and findings when the paper was asked for. It reads the run's sources, claims, findings and files with the same read-only tools as the teachers. The run's **Answer check** and its brief say `the final writer is writing the paper` meanwhile.

The paper is one whole paper in Simplified Technical English (STE), descriptive text, in Markdown. It has these parts, in this order: its title; **Summary**; **Questions**; **Method**, with how the sources were found, archived and checked and the figures; **Results**, one `### Question N` section for each question, with the answer and its evidence; **Hypotheses**, one section for each hypothesis with its verdict (`Verdict: supported`, `refuted` or `undecided`) and evidence; **Limits of the evidence**, such as claims from a single site, open gaps and draft findings left unverified; and **Next experiments**. Each sentence that states a fact cites its claims as `[c-ID]`. The writer types no references: code appends a **References** part, each cited claim with the title or address and the site of each source its quotes come from.

Code checks the paper before it is accepted, in the harness, where the writer cannot change the checks:

- every cited `[c-ID]` is a verified claim of the run;
- every number in a paragraph, a list item or a table row is in the claims it cites, or is one of the figures the writer was given. Numbers in headings, record ids and question numbers are not checked;
- every question has its results section, which cites at least one claim, and the parts are all there, in order;
- every hypothesis has a verdict, and it is one the review panel gave (or `undecided` when no reviewer's verdict passed the check): the writer reports the verdicts, it does not judge;
- when the rig has an STE checker, the checker found no error in the paper. The supervisor runs the checker itself on the text it posts; the model never reports its own result.

The writer checks its drafts first with two tools: `check_paper` runs the harness's checks on a draft and gives each problem with its line, and `ste_check` runs the rig's STE checker. Each step is an event of the run, with a line in its **History**: `research_paper_requested` when the writer is asked (with the figures it is given), `research_paper_refused` with the problems (the first 20) and whether the STE checker ran, and `research_paper_accepted` with the writer, the STE checker's result or why there was none, the number of claims cited, the next experiments and the paper. A paper that fails is refused with its problems, which also go in the writer's next brief; the writer revises it in the same call (in Pi) or at the supervisor's next round. There is no limit on tries unless the advisors file sets one for its model, such as `max_turns` or `timeout_s`.

Thermite ships no STE checker and none of the standard's vocabulary: ASD-STE100's notice forbids sharing the standard. A deployment that has a checker gives the supervisor its path ([`THERMITE_STE_CHECKER`](../reference/settings.md#places-and-advisors)); its guide, when one is beside it, goes in the writer's prompt, and without a checker the prompt has short STE rules of Thermite's own. A paper written on a rig without a checker is accepted as not checked for STE, and says so.

An accepted paper is `paper.md` in the run's research folder at once, and starts the run's final report, which is written once the run's running trials end; the run then closes. The run's next export carries the folder with the paper, and the knowledge base's final report holds it. The writer also gives each of its next experiments as an item: a title, why, details, and the supported findings or verified claims it rests on. Code keeps each one as an experiment in the campaign's folder of the [knowledge base](../reference/knowledge-base.md), from the run and the writer (`writer:<name>`), with what it rests on in words, so **Start a run** can take it into a goal or hill-climb run's queue from **From past research**.

## Choosing a mode

- You have a **number** to make better, and things that must not break: a **hill climb**.
- You have a **list of conditions** that the work must meet, and you want to know if it can: a **goal** campaign.
- You have a **question**, and a few hours or days to spend on it: a **research** campaign.

The first step of the **New campaign** page, **Aim**, offers the three as **Hill climb**, **Reach a list of goals** and **Research a question**. [Choose a campaign mode](../how-to/campaigns/choose-a-mode.md) says what each one needs before you start, and [Your own project](../tutorials/your-own-project.md) starts a hill climb there.
