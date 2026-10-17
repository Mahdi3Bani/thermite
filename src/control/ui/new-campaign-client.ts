/**
 * The new-campaign page's script, served from control (/ui/assets/new-campaign.js; no inline
 * script runs under the dashboard's CSP). It moves between the steps, keeps the choices, asks
 * control to look up the project, and on submit gathers the answers into one draft (JSON) for
 * control to check and build. It reads what the owner typed and builds text with DOM text
 * nodes or escaped strings only.
 */
export const NEW_CAMPAIGN_JS = `
(() => {
  "use strict";
  const form = document.getElementById("nc");
  if (!form) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const val = (name) => (form.elements[name] ? String(form.elements[name].value).trim() : "");
  const lines = (name) => val(name).split("\\n").map((x) => x.trim()).filter(Boolean);
  const words = (name) => val(name).split(/[\\s,]+/).filter(Boolean);
  const choice = {};
  $$(".ch.on[data-group]").forEach((c) => (choice[c.dataset.group] = c.dataset.value));

  // ------------------------------------------------ steps
  const order = () => $$("#steps li").filter((li) => !li.hidden).map((li) => li.dataset.step);
  let cur = "aim";
  const go = (id) => {
    cur = id;
    const o = order(), at = o.indexOf(id);
    $$("#steps li").forEach((li) => {
      li.classList.toggle("on", li.dataset.step === id);
      li.classList.toggle("done", o.indexOf(li.dataset.step) > -1 && o.indexOf(li.dataset.step) < at);
    });
    $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== id));
    window.scrollTo({ top: 0 });
  };
  $("#steps").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) go(li.dataset.step); });

  // ------------------------------------------------ choices, rows, placeholders
  form.addEventListener("click", (e) => {
    if (e.target.closest(".ii")) { e.preventDefault(); return; }
    const c = e.target.closest(".ch[data-group]");
    if (c && !c.classList.contains("dis")) {
      $$('.ch[data-group="' + c.dataset.group + '"]').forEach((x) => x.classList.toggle("on", x === c));
      choice[c.dataset.group] = c.dataset.value;
      update();
    }
    const nav = e.target.closest("[data-next],[data-back]");
    if (nav) { e.preventDefault(); const o = order(), i = o.indexOf(cur); go(o[i + (nav.hasAttribute("data-next") ? 1 : -1)] || cur); }
    const add = e.target.closest("[data-add]");
    if (add) {
      e.preventDefault();
      const body = $(add.dataset.add + " tbody"), tpl = body.querySelector("tr");
      const row = tpl.cloneNode(true);
      row.querySelectorAll("input").forEach((i) => (i.value = ""));
      body.appendChild(row);
    }
    const del = e.target.closest("[data-del]");
    if (del) { e.preventDefault(); const tr = del.closest("tr"); if (tr.parentElement.children.length > 1) tr.remove(); update(); }
    const ph = e.target.closest("[data-ph]");
    if (ph) { e.preventDefault(); const t = form.elements[ph.dataset.into]; t.value = (t.value + " " + ph.dataset.ph).trim(); update(); }
    const sug = e.target.closest("[data-path]");
    if (sug) { e.preventDefault(); const t = form.elements.editable_paths; if (!lines("editable_paths").includes(sug.dataset.path)) t.value = (t.value.trim() + "\\n" + sug.dataset.path).trim(); update(); }
  });
  form.addEventListener("input", () => update());
  form.addEventListener("change", () => update());

  // ------------------------------------------------ the project: control looks it up
  let found = null;
  const probe = async () => {
    const out = $("#probe-out");
    const url = val("project_url"), ref = val("project_ref") || "HEAD";
    if (!url) return;
    out.textContent = "Looking it up…";
    try {
      const res = await fetch("/ui/campaigns/new/probe?" + new URLSearchParams({ url, ref }), { credentials: "same-origin" });
      const j = await res.json();
      if (!res.ok) { found = null; out.textContent = j.error || "Control could not read it."; update(); return; }
      found = j;
      out.textContent = "";
      const b = document.createElement("b"); b.textContent = ref;
      out.append("Found: ", b, " is at ", j.commit.slice(0, 7), " · " + j.files + " files. Rigs fetch it from there.");
      const sug = $("#suggest"); sug.replaceChildren();
      for (const p of j.suggest) { const btn = document.createElement("button"); btn.className = "sm"; btn.dataset.path = p; btn.textContent = p; sug.append(btn); }
      update();
    } catch { out.textContent = "Control could not reach the repository."; }
  };
  $("#probe")?.addEventListener("click", (e) => { e.preventDefault(); probe(); });

  // ------------------------------------------------ the draft
  const repoName = (url) => (url.replace(/\\.git$/, "").split(/[/:]/).pop() || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "project";
  const files = [];
  $("#kit-files")?.addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
      files.push({ name: f.name, content_base64: b64, run: $("#kit-files-run").checked });
    }
    const list = $("#kit-files-list"); list.textContent = files.map((f) => f.name + (f.run ? " (the run reads it)" : "")).join(", ");
    e.target.value = "";
  });
  const num = (name) => { const n = Number(val(name)); return Number.isFinite(n) && val(name) !== "" ? n : undefined; };
  const draft = () => {
    const mode = choice.mode || "hill_climb";
    const d = { mode, campaign: val("campaign"), title: val("title"), lanes: Number(val("lanes") || 2), limits: {} };
    if (val("notes")) d.notes = val("notes");
    for (const k of ["trial_minutes", "run_rss_mib", "workspace_mib"]) { const n = num(k); if (n !== undefined) d.limits[k] = n; }
    if (num("wall_hours")) d.wall_hours = num("wall_hours");
    if (mode === "research") {
      d.research = { topic: val("topic"), questions: lines("questions"), seeds: lines("seeds"), min_duration: val("min_duration") };
      return d;
    }
    const url = val("project_url");
    d.project = { url, ref: val("project_ref") || undefined, commit: found ? found.commit : undefined, repo: repoName(url), editable_paths: lines("editable_paths"), forbidden_patterns: lines("forbidden_patterns") };
    if ((choice.kit || "here") === "here") {
      const cases = $$("#cases tbody tr").map((tr) => {
        const [name, params, work] = [...tr.querySelectorAll("input")].map((i) => i.value.trim());
        const p = {};
        for (const kv of params.split(/\\s+/).filter(Boolean)) { const at = kv.indexOf("="); if (at > 0) { const v = kv.slice(at + 1); p[kv.slice(0, at)] = v !== "" && Number.isFinite(Number(v)) ? Number(v) : v; } }
        return { name, params: p, ...(work ? { work: Number(work) } : {}) };
      }).filter((c) => c.name);
      d.kit = { source: "here", build: val("build"), outputs: words("outputs"), cases, run: val("run"), check: val("check"), files, held_out: words("held_out") };
    } else {
      d.kit = { source: "repo", url: val("kit_url"), commit: val("kit_commit"), repo: repoName(val("kit_url")), cells: words("kit_cells"), held_out: words("held_out_repo") };
    }
    d.score = { name: ((choice.kit || "here") === "repo" ? val("repo_metric") : val("score_name")) || "rate", unit: val("score_unit") || "runs/s", direction: val("direction") || "max", min_effect: (num("min_effect") ?? 5) / 100 };
    if (mode === "goal") {
      d.goals = $$("#goals tbody tr").map((tr, i) => {
        const [desc, detail] = [...tr.querySelectorAll("input")].map((x) => x.value.trim());
        const kind = tr.querySelector("select").value;
        const id = (desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "goal") + "-" + (i + 1);
        if (kind === "check") return { id, description: desc, verify: { type: "check", cells: detail.split(/[\\s,]+/).filter(Boolean) } };
        if (kind === "review") return { id, description: desc, verify: { type: "review", criteria: detail.split(";").map((x) => x.trim()).filter(Boolean) } };
        const m = /^(>=|<=|>|<)\\s*([-+0-9.eE]+)\\s+on\\s+(.+)$/.exec(detail);
        return { id, description: desc, verify: m ? { type: "metric", op: m[1], value: Number(m[2]), cells: m[3].split(/[\\s,]+/).filter(Boolean) } : { type: "metric", op: ">=", value: NaN, cells: [] } };
      }).filter((g) => g.description);
    }
    return d;
  };

  // ------------------------------------------------ what the page says back
  const update = () => {
    const mode = choice.mode || "hill_climb";
    $$("[data-modes]").forEach((el) => (el.hidden = !el.dataset.modes.split(" ").includes(mode)));
    $$("[data-kit]").forEach((el) => (el.hidden = el.dataset.kit !== (choice.kit || "here")));
    const rig = choice.rig || "", lanes = val("lanes") || "2";
    const aim = { hill_climb: "make " + (val("score_name") || "its score") + " " + (val("direction") === "min" ? "lower" : "higher") + ", keeping only changes the judge confirms are at least " + (val("min_effect") || "5") + "% better", goal: "reach its goals, each checked by the judge", research: "research " + (val("topic") || "its topic") + " and report checked findings" }[mode];
    const proj = mode === "research" ? "" : " on " + repoName(val("project_url") || "the project") + (found ? " at " + found.commit.slice(0, 7) : "") + ", changing only " + (lines("editable_paths").join(", ") || "(no files yet)");
    const s = (val("campaign") || "The campaign") + " will " + aim + proj + ". " + lanes + " agent" + (lanes === "1" ? "" : "s") + " work on " + (rig || "(no rig chosen)") + ".";
    for (const el of $$("[data-summary]")) el.textContent = s;
    $("#draft-preview") && ($("#draft-preview").textContent = JSON.stringify(draft(), null, 2));
  };

  form.addEventListener("submit", (e) => {
    form.elements.draft.value = JSON.stringify(draft());
    form.elements.rig.value = choice.rig || "";
    if (e.submitter && e.submitter.name === "start") form.elements.start_value.value = e.submitter.value;
  });

  // A page sent back with mistakes keeps what was typed (the server echoes the draft).
  const back = form.dataset.draft ? JSON.parse(form.dataset.draft) : null;
  if (back) {
    const set = (n, v) => { if (form.elements[n] && v !== undefined && v !== null) form.elements[n].value = Array.isArray(v) ? v.join(n === "editable_paths" || n === "forbidden_patterns" || n === "questions" || n === "seeds" ? "\\n" : " ") : v; };
    set("campaign", back.campaign); set("title", back.title); set("notes", back.notes); set("lanes", back.lanes);
    if (back.project) { set("project_url", back.project.url); set("project_ref", back.project.ref); set("editable_paths", back.project.editable_paths); set("forbidden_patterns", back.project.forbidden_patterns); }
    if (back.kit && back.kit.source === "here") { for (const k of ["build", "run", "check"]) set(k, back.kit[k]); set("outputs", back.kit.outputs); set("held_out", back.kit.held_out); }
    if (back.score) { set("score_name", back.score.name); set("score_unit", back.score.unit); set("direction", back.score.direction); set("min_effect", back.score.min_effect * 100); }
    if (back.research) { set("topic", back.research.topic); set("questions", back.research.questions); set("seeds", back.research.seeds); set("min_duration", back.research.min_duration); }
    $$('.ch[data-group="mode"]').forEach((c) => { c.classList.toggle("on", c.dataset.value === back.mode); });
    choice.mode = back.mode;
  }
  go(form.dataset.step || "aim");
  update();
})();
`;
