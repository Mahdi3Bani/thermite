/**
 * The dashboard's only script, served from control itself (CSP script-src 'self'; nothing inline
 * runs). It streams the live view; pages never reload by themselves. Live lines are built with
 * DOM text nodes only: rig data never becomes markup here either.
 */
export const CLIENT_JS = `
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  // ------------------------------------------------ the live view
  const tr = $("#transcript");
  if (tr) {
    const rig = tr.dataset.rig, source = tr.dataset.source || "";
    let after = Number(tr.dataset.after || "0");
    const near = () => tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
    tr.scrollTop = tr.scrollHeight;
    // Each line comes formatted from control (ui/live.ts, escaped there). A result joins the
    // tool call just before it: its time, exit code and first line go into the call's row.
    const add = (e) => {
      const last = tr.lastElementChild;
      const open = last && last.querySelector("details[data-open]");
      if (e.kind === "result" && e.join && open) {
        open.removeAttribute("data-open");
        const hint = open.querySelector(".lv-hint");
        if (hint) hint.insertAdjacentHTML("beforeend", e.join.hint);
        open.insertAdjacentHTML("beforeend", e.join.body);
        return;
      }
      const empty = tr.querySelector(".empty");
      if (empty) empty.remove();
      tr.insertAdjacentHTML("beforeend", e.html);
    };
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const q = new URLSearchParams({ after: String(after) });
        if (source) q.set("source", source);
        const res = await fetch("/ui/rigs/" + encodeURIComponent(rig) + "/live.json?" + q, { credentials: "same-origin" });
        if (!res.ok) return;
        const body = await res.json();
        const stick = near();
        for (const e of body.entries || []) { add(e); after = Math.max(after, e.id); }
        if (stick && (body.entries || []).length) tr.scrollTop = tr.scrollHeight;
        const st = $("#live-state .sub");
        if (st) st.textContent = "live · " + new Date().toISOString().slice(11, 19) + " UTC";
      } catch {}
    };
    setInterval(poll, 2000);
  }

  // ------------------------------------------------ info icons: a label's description on hover
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);
  const showTip = (el) => {
    tip.textContent = el.dataset.tip || "";
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    let x = Math.min(r.left - 8, window.innerWidth - tip.offsetWidth - 12);
    if (x < 12) x = 12;
    let y = r.bottom + 8;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = r.top - tip.offsetHeight - 8;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  };
  const hideTip = () => (tip.style.display = "none");
  document.addEventListener("mouseover", (ev) => { const i = ev.target.closest && ev.target.closest(".ii"); if (i) showTip(i); });
  document.addEventListener("mouseout", (ev) => { if (ev.target.closest && ev.target.closest(".ii")) hideTip(); });
  document.addEventListener("focusin", (ev) => { const i = ev.target.closest && ev.target.closest(".ii"); if (i) showTip(i); });
  document.addEventListener("focusout", hideTip);

  // ------------------------------------------------ panels: open in place, close with Esc
  // Links with data-open show the panel without a reload (they still work as links without
  // this script); data-close hides it again.
  document.addEventListener("click", (ev) => {
    const open = ev.target.closest && ev.target.closest("[data-open]");
    if (open) {
      const el = $(open.dataset.open);
      if (el) { ev.preventDefault(); el.hidden = false; const f = el.querySelector("input:not([type=hidden]):not([disabled]), select, textarea"); if (f) f.focus(); }
      return;
    }
    const close = ev.target.closest && ev.target.closest("[data-close]");
    if (close) { const w = close.closest(".drawer-wrap"); if (w) { ev.preventDefault(); w.hidden = true; } }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") document.querySelectorAll(".drawer-wrap:not([hidden])").forEach((w) => (w.hidden = true));
  });

  // ------------------------------------------------ Start a run: the model pick and the summary
  const start = $("form[data-start]");
  if (start) {
    const sum = start.querySelector("[data-start-sum]");
    const pick = start.querySelector("[data-model-pick]");
    const line = start.querySelector("[data-model-line]");
    const update = () => {
      const rig = start.querySelector("input[name=rig]:checked");
      const agents = (start.querySelector("input[name=agents]:checked") || {}).value !== "off";
      const has = rig ? rig.dataset.model : "";
      const chosen = start.querySelector("select[name=agents_model]");
      const picked = chosen && chosen.value ? decodeURIComponent(chosen.value.split("|")[1] || "") : "";
      if (pick) pick.hidden = !agents || !!has;
      if (line) line.textContent = has ? "The rig's agents, on " + has + "." : "This rig has no model for its agents yet: pick one below.";
      if (sum) sum.textContent = rig ? "Starts a new run on " + rig.value + (agents ? ", with agents on " + (picked || has || "a model you pick") + "." : ", as a try: the judge only.") : "Choose a rig.";
    };
    start.addEventListener("change", update);
    update();
  }

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
