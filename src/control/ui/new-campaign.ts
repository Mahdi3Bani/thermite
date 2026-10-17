import type { GitAccess } from "../store.ts";
import type { RigView } from "../views.ts";
import { esc } from "./components.ts";

/**
 * The new-campaign page (owner decision 38, from the approved mockup): a campaign from nothing
 * in five steps (aim, project, how to measure, where, review), with every setting beyond the
 * simple ones folded under Advanced and a description behind every label's info icon. The
 * page's script (/ui/assets/new-campaign.js) gathers the answers into one draft; control
 * checks and builds it (campaign-builder.ts) and starts the first run (new-campaign.ts).
 */

export interface NewCampaignPage {
  csrf: string;
  rigs: RigView[];
  /** Git access kept in Settings, for private repositories. */
  access?: GitAccess[] | undefined;
  /** A draft sent back with mistakes, to fill the form again. */
  draft?: Record<string, unknown> | undefined;
  errors?: string[] | undefined;
}

/** A label with its info icon: hovering or focusing the icon shows what the field means. */
export const infoLabel = (text: string, tip: string) =>
  `<span class="lb">${esc(text)}<i class="ii" tabindex="0" data-tip="${esc(tip)}">i</i></span>`;

const field = (text: string, tip: string, control: string) =>
  `<label class="fd">${infoLabel(text, tip)}${control}</label>`;

const choice = (
  group: string,
  value: string,
  title: string,
  body: string,
  on = false,
  dis = false,
) =>
  `<div class="ch${on ? " on" : ""}${dis ? " dis" : ""}" data-group="${esc(group)}" data-value="${esc(value)}" tabindex="0"><span class="dotx"></span><span><b>${esc(title)}</b><span class="muted">${body}</span></span></div>`;

const step = (n: number, id: string, title: string, modes = "") =>
  `<li data-step="${id}"${modes ? ` data-modes="${modes}"` : ""}><span class="k">${n}</span>${esc(title)}</li>`;

interface CaseDraft {
  name?: string;
  params?: Record<string, unknown>;
  work?: number;
}

export function newCampaignBody(p: NewCampaignPage): string {
  const d = (p.draft ?? {}) as {
    mode?: string;
    kit?: { source?: string; cases?: CaseDraft[] };
    goals?: { description?: string; verify?: { type?: string; cells?: string[] } }[];
  };
  const mode = d.mode ?? "hill_climb";
  const cases: CaseDraft[] = d.kit?.cases?.length
    ? d.kit.cases
    : [
        { name: "small", params: { n: 1024 } },
        { name: "large", params: { n: 4096 } },
      ];
  const caseRow = (c: CaseDraft) =>
    `<tr><td><input aria-label="case name" value="${esc(c.name ?? "")}" placeholder="small"></td><td><input class="mono" aria-label="parameters" value="${esc(
      Object.entries(c.params ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    )}" placeholder="n=1024"></td><td><input class="mono" aria-label="work per run" value="${esc(c.work === undefined ? "" : String(c.work))}" placeholder="2147483648"></td><td><button class="sm" data-del>×</button></td></tr>`;
  const goals = d.goals?.length
    ? d.goals
    : [{ description: "", verify: { type: "check", cells: [] as string[] } }];
  const goalRow = (g: { description?: string; verify?: { type?: string; cells?: string[] } }) =>
    `<tr><td><input aria-label="the goal" value="${esc(g.description ?? "")}" placeholder="It builds and its tests pass"></td><td><select aria-label="checked by"><option value="check"${g.verify?.type === "check" ? " selected" : ""}>the check passes on cases</option><option value="metric"${g.verify?.type === "metric" ? " selected" : ""}>the score reaches</option><option value="review"${g.verify?.type === "review" ? " selected" : ""}>people review it</option></select></td><td><input aria-label="detail" value="${esc((g.verify?.cells ?? []).join(" "))}" placeholder="small large  ·  >= 4e13 on large  ·  clear names; no dead code"></td><td><button class="sm" data-del>×</button></td></tr>`;

  // Rigs that can run a campaign on the kit's target. A rig with no hardware report shows, and
  // its target is whatever it reports later (control refuses a mismatch at assignment).
  const rigChoices = p.rigs
    .map((u, i) => {
      const t = u.hardware?.target;
      const running = u.runs.filter((r) => r.status === "running").length;
      const what = [
        t ? `${t.type} · ${esc(t.class)}` : "has not reported its hardware",
        u.stale
          ? "not reporting now"
          : running
            ? `${running} run${running === 1 ? "" : "s"} running`
            : "idle",
        u.model?.model
          ? `agents: ${esc(u.model.model)}${u.model.harness === "opencode" ? " (OpenCode v2)" : ""}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return choice("rig", u.id, u.id, what, i === 0, u.stale);
    })
    .join("");

  const accessOptions = (p.access ?? [])
    .map(
      (g) =>
        `<option value="${esc(g.name)}">${esc(g.name)} · ${g.kind === "ssh" ? "SSH deploy key" : "HTTPS token"}</option>`,
    )
    .join("");
  const noAccess = !(p.access ?? []).length;
  const errors = p.errors?.length
    ? `<div class="card bad" style="margin-bottom:16px"><b>Not started: fix these first.</b><ul style="margin:6px 0 0 18px">${p.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul></div>`
    : "";

  return `<p class="run-said">A campaign is one aim for your project: agents propose changes, and a judge they cannot touch measures each one and keeps only what is better. Start with the aim and your project; every setting beyond the simple ones is under Advanced.</p>
${errors}
<form id="nc" method="post" action="/ui/campaigns/new" data-draft="${esc(p.draft ? JSON.stringify(p.draft) : "")}" data-step="${p.errors?.length ? "review" : "aim"}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}"><input type="hidden" name="draft"><input type="hidden" name="rig"><input type="hidden" name="start_value" value="start">
<div class="wiz">
<ol class="nc-steps" id="steps">${step(1, "aim", "Aim")}${step(2, "project", "Project", "hill_climb goal")}${step(3, "measure", "How to measure", "hill_climb goal")}${step(3, "research", "The question", "research")}${step(4, "where", "Where it runs")}${step(5, "review", "Review and start")}</ol>
<div>
<section class="pane" data-pane="aim"><div class="sec"><h2>What should this campaign do?</h2><p class="lead">This decides how the judge tells better from worse.</p>
<div class="cards3">
${choice("mode", "hill_climb", "Hillclimbing", "Improve one measured number: speed, size or accuracy. A change is kept only when the judge measures it as better.<br><i>For example: a faster matrix multiply on this GPU.</i>", mode === "hill_climb")}
${choice("mode", "goal", "Reach a list of goals", "Say what the result must do, as checks: it builds, it loads the model, its answers match. The campaign ends when the goals are met.<br><i>For example: support a new quantized format.</i>", mode === "goal")}
${choice("mode", "research", "Research a question", "Agents read sources and report findings, each backed by quotes Thermite checks. No code changes.<br><i>For example: which papers improve 2-bit decoding?</i>", mode === "research")}
</div></div>
<div class="g2" style="max-width:760px">${field("Campaign name", "A short name: lowercase letters, digits, dots, dashes. Its runs are named after it (name-1, name-2). Using a name again makes a new version of that campaign.", `<input name="campaign" required placeholder="matmul-speed">`)}${field("Title", "A sentence for people about what this campaign is for. Agents read it too.", `<input name="title" required placeholder="Make the GPU matrix multiply faster">`)}</div>
<div class="act"><button class="primary" data-next>Next</button></div></section>

<section class="pane" data-pane="project" hidden><div class="sec"><h2>Your project</h2><p class="lead">The code the agents change. Each rig fetches it itself from the repository, at the commit control looks up now.</p>
<div class="g2" style="max-width:860px">${field("Repository", "The project's git repository, as https://… . Rigs fetch it; Thermite never pushes to it. Private repositories need a key, which comes with Settings › Providers › Git access.", `<input name="project_url" placeholder="https://github.com/you/project.git">`)}${field("Start from", "A branch, tag or full commit. Control pins it to the exact commit now, so every run starts from the same code.", `<input name="project_ref" placeholder="main">`)}</div>
<div style="max-width:420px">${field("Repository access", "Public needs nothing. A private repository needs Git access, set up once in Settings: a deploy key control makes (for ssh:// and git@host:path addresses) or an HTTPS token. Only rigs that run this campaign receive it.", `<select name="project_access"><option value="">Public: no key</option>${accessOptions}</select>`)}${noAccess ? `<div class="muted small" style="margin:-8px 0 12px">No Git access yet: <a href="/ui/settings">add a deploy key or a token in Settings</a>.</div>` : ""}</div>
<div class="act" style="margin-bottom:12px"><button class="sm" id="probe">Look it up</button><span class="muted small" id="probe-out">Control reads the repository's files (not their contents) to suggest the paths below.</span></div>
${field("Files the agents may change", "Patterns, one per line. A change to any other file is refused before the judge builds it, so agents cannot touch your tests or benchmark. ** matches any folders.", `<textarea name="editable_paths" placeholder="src/kernels/**"></textarea>`)}
<div class="ph" id="suggest"></div>
<details class="adv"><summary>Advanced</summary><div>
${field("Lines never allowed", "Regular expressions, one per line. A change that adds a matching line is refused before building, for example one that reads the benchmark's clock.", `<textarea name="forbidden_patterns" placeholder="clock_gettime"></textarea>`)}
</div></details>
<div class="act" style="margin-top:12px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="measure" hidden><div class="sec"><h2>How to measure</h2><p class="lead">The kit: how the judge builds your project, runs it on test cases and checks the output. Agents never see it. Thermite times every run with its own clock; nothing the program prints counts as a score.</p>
<div class="cards3">
${choice("kit", "here", "Describe it here", "A few commands and test cases. Control writes the kit and keeps it. Best for a first campaign.", d.kit?.source !== "repo")}
${choice("kit", "repo", "A kit in a repository", "You keep the kit in git, with its own kit.json and scripts.", d.kit?.source === "repo")}
${choice("kit", "upload", "Upload a kit", "A .zip or .tar.gz with kit.json at its top. Coming next.", false, true)}
</div>
<div data-kit="here" style="margin-top:14px">
<div class="g2">${field("Build", "The command that builds the project, run in a fresh copy of the code as a user who can write only there.", `<input class="mono" name="build" placeholder="cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j8">`)}${field("What the build makes", "The files or folders the run needs, relative to the project, separated by spaces. The judge keeps exactly these, hashed, so a run cannot swap them.", `<input class="mono" name="outputs" placeholder="build/bench">`)}</div>
${field("Test cases", "Each case is a set of parameters the run receives, such as a problem size (n=1024). Work per run is how much one run does, for example 2·n³ operations: the score is the work divided by the time. A hill climb needs it; goals do not.", `<table class="tbl" id="cases"><thead><tr><th>Name</th><th>Parameters</th><th>Work per run</th><th></th></tr></thead><tbody>${cases.map(caseRow).join("")}</tbody></table><div class="act" style="margin-top:6px"><button class="sm" data-add="#cases">Add a case</button></div>`)}
${field("Run", "The command that runs one build on one case. {build} is the folder with the build's files (a file keeps its path: {build}/build/bench), {out} is where to write results, and each parameter is {name}, for example {n}.", `<input class="mono" name="run" placeholder="{build}/build/bench --n {n} --out {out}/result.bin">`)}
<div class="ph"><button class="sm" data-ph="{build}" data-into="run">{build}</button><button class="sm" data-ph="{out}" data-into="run">{out}</button><button class="sm" data-ph="{kit}" data-into="run">{kit}</button></div>
<div style="height:12px"></div>
${field("Is it right?", "A command that checks one run's output and exits 0 when it is correct. A fast but wrong run is invalid, never a win. It runs as the judge, with the files you add below in {kit}.", `<input class="mono" name="check" placeholder="python3 {kit}/check.py {out}/result.bin {n}">`)}
${field("Files for the check", "References and scripts the check uses, such as check.py or expected outputs. The run cannot read them unless you tick the box: never let it read reference answers.", `<span class="act"><input type="file" id="kit-files" multiple><label class="small"><input type="checkbox" id="kit-files-run"> the run reads these too</label><span class="muted small" id="kit-files-list"></span></span>`)}
<div data-modes="hill_climb" style="margin-top:6px"><div class="g3">
${field("Score name", "What the score is called, for example throughput.", `<input name="score_name" placeholder="throughput">`)}
${field("Unit", "Shown with the score, for example FLOP/s.", `<input name="score_unit" placeholder="FLOP/s">`)}
${field("Better is", "Whether a higher or a lower score is better.", `<select name="direction"><option value="max">higher</option><option value="min">lower</option></select>`)}
${field("Smallest gain that counts (%)", "A change must beat the current best by at least this much, confirmed statistically, to be kept. Smaller differences count as no change.", `<input name="min_effect" value="5">`)}
</div></div>
<details class="adv"><summary>Advanced</summary><div class="g3">
${field("Cases held back", "Case names, separated by spaces, measured only to confirm a win, never while screening, so agents cannot tune a change to them.", `<input name="held_out" placeholder="none">`)}
</div></details>
</div>
<div data-kit="repo" style="margin-top:14px" hidden><div class="g3">${field("Kit repository", "The git repository holding kit.json and its scripts.", `<input name="kit_url" placeholder="https://… .git">`)}${field("Kit repository access", "Public needs nothing; a private kit repository needs Git access from Settings.", `<select name="kit_access"><option value="">Public: no key</option>${accessOptions}</select>`)}${field("Kit commit", "The full commit of the kit to use.", `<input class="mono" name="kit_commit" placeholder="40 hexadecimal characters">`)}${field("Cases to measure", "The kit's case names this campaign measures, separated by spaces.", `<input name="kit_cells" placeholder="small large">`)}</div>
${field("Cases held back", "Measured only to confirm a win.", `<input name="held_out_repo" placeholder="none">`)}
<div data-modes="hill_climb"><div class="g3">${field("The kit's metric", "The name of the metric in the kit's kit.json to improve.", `<input name="repo_metric" placeholder="flops_per_s">`)}</div></div></div>
<div data-modes="goal" style="margin-top:14px">${field("Goals", "What the result must do. Each goal is checked by the judge: the check passes on some cases (list their names), the score reaches a value (write >= 4e13 on large), or people review it (criteria separated by ;).", `<table class="tbl" id="goals"><thead><tr><th style="width:40%">The goal</th><th>Checked by</th><th>Detail</th><th></th></tr></thead><tbody>${goals.map(goalRow).join("")}</tbody></table><div class="act" style="margin-top:6px"><button class="sm" data-add="#goals">Add a goal</button></div>`)}</div>
<div class="act" style="margin-top:14px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="research" hidden><div class="sec"><h2>The question</h2>
${field("Topic", "What the agents research, in a sentence.", `<input name="topic">`)}
${field("Questions", "One per line. Every finding must answer one of them.", `<textarea name="questions"></textarea>`)}
${field("Starting links", "Pages to start from, one per line. Without a search service, agents follow links from these.", `<textarea name="seeds"></textarea>`)}
${field("Run for at least", "Research keeps going this long, collecting and checking sources: for example 8h or 2d.", `<input name="min_duration" value="8h">`)}
<div class="act"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="where" hidden><div class="sec"><h2>Where it runs</h2><p class="lead">A rig with the hardware your kit measures on. Its first run starts there; later runs can go to other rigs.</p>
<div class="g2"><div>${rigChoices || `<div class="card"><div class="empty">No rig yet. Add one first.</div></div>`}</div></div>
<div class="g3" style="margin-top:14px">
${field("Agents working at once", "How many agents work in parallel, each trying its own idea in its own copy of the code. More agents explore more ideas at once, and share the rig's CPUs, memory and model.", `<select name="lanes"><option>1</option><option selected>2</option><option>3</option><option>4</option></select>`)}
${field("When a change is confirmed better", "What happens when the judge confirms a change beats the current best: keep it at once as the new best, or wait for you. The rig's default is set where the rig is deployed.", `<select name="promotion"><option value="">the rig's default</option><option value="auto">always keep it</option><option value="owner_approval">ask me every time</option></select>`)}
</div>
<details class="adv"><summary>Advanced</summary><div class="g3">
${field("One try lasts (minutes)", "How long an agent works on one idea before it must submit; then it starts fresh on its next idea. Empty: the rig's default.", `<input name="trial_minutes" placeholder="the rig's default">`)}
${field("Memory per agent (MiB)", "Memory for everything one agent runs at once. A command that goes over is stopped. Empty: 2048.", `<input name="run_rss_mib" placeholder="2048">`)}
${field("Disk per agent (MiB)", "Disk for one try's copy of the code and its builds. Empty: 2048.", `<input name="workspace_mib" placeholder="2048">`)}
${field("Stop after (hours)", "Stop the agents after this many hours. Empty: no limit; the campaign runs until it is done or you stop it.", `<input name="wall_hours" placeholder="no limit">`)}
${field("Notes for the agents", "Anything the agents should know: constraints, ideas to avoid, where to look.", `<textarea name="notes"></textarea>`)}
</div></details>
<div class="act" style="margin-top:12px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>

<section class="pane" data-pane="review" hidden><div class="sec"><h2>Review and start</h2>
<div class="card hl"><p class="sum" data-summary></p>
<div class="act"><button class="primary big" name="start" value="start">Start the campaign</button><button name="start" value="save">Save without starting</button></div>
<div class="nc-does"><b>What happens.</b> Control checks everything, writes the kit into a repository of its own if you described it here, saves the campaign as its next version approved in your name, and assigns the first run to the rig. The rig fetches the project and the kit, checks both, and the judge measures the starting point before any agent submits.</div></div>
<details class="adv" style="margin-top:12px"><summary>What control will check (the draft)</summary><div><pre class="json" id="draft-preview"></pre></div></details></div>
<div class="act"><button data-back>Back</button></div></section>
</div></div>
</form>
<script src="/ui/assets/new-campaign.js" defer></script>`;
}
