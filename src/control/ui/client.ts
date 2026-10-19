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

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
