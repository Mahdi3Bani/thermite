/**
 * The Edit rig page's script, served from control (/ui/assets/edit-rig.js; no inline script runs
 * under the dashboard's CSP). It shows each switch's state and lists, in sentences, what Save
 * changes. Without it the form still works.
 */
export const EDIT_RIG_JS = `
(() => {
  "use strict";
  const form = document.getElementById("edit-rig");
  if (!form) return;
  const start = new Map();
  for (const el of form.elements) if (el.name) start.set(el, el.type === "checkbox" || el.type === "radio" ? el.checked : el.value);
  const label = (el) => {
    if (el.dataset.label) return el.dataset.label;
    const lb = el.closest(".fd") && el.closest(".fd").querySelector(".lb");
    return lb ? lb.firstChild.textContent.trim().toLowerCase() : el.name;
  };
  // Where each agent runs, from the model chosen for it (a Claude subscription: Claude Code only).
  // The planner follows the workers' model, and their harness when it is Codex; an advisor with
  // none uses the rig's advisors file. A row whose model is unchanged keeps the harness control
  // has for it (data-saved), which MCP or REST may have set.
  const runsIn = () => {
    const kindOf = (sel) => (sel.selectedOptions[0] && sel.selectedOptions[0].dataset.kind) || "";
    const text = (role, kind) => kind === "claude" ? "Claude Code, past research and the kit's MCP tools only" : role === "planner" ? (kind === "opencode" ? "OpenCode" : "Pi") : kind === "opencode" ? "OpenCode v2 in the supervisor, past research and the kit's MCP tools only" : "the supervisor, read-only tools";
    const workers = form.querySelector('[data-role="workers"]');
    const harness = form.querySelector("[data-harness]");
    const wKind = workers ? kindOf(workers) : "";
    if (harness && wKind === "claude") harness.value = "claude-code";
    if (harness && wKind === "chatgpt" && harness.value === "claude-code") harness.value = "pi";
    const asWorkers = harness && harness.value === "codex" && wKind !== "claude" ? "Codex" : text("planner", wKind);
    const lanes = Number((form.querySelector('[name="lanes"]') || {}).value) || 1;
    const sessions = { workers: lanes, teachers: 2, panel: 3 };
    let claude = 0;
    let chatgpt = 0;
    for (const sel of form.querySelectorAll("[data-role]")) {
      const role = sel.dataset.role;
      const own = kindOf(sel);
      const kind = own || (role === "planner" ? wKind : "");
      const cell = form.querySelector('[data-runs="' + role + '"]');
      const saved = cell && cell.dataset.saved && sel.value === start.get(sel) ? cell.dataset.saved : "";
      if (cell)
        cell.textContent = saved || (own ? text(role, own) : role !== "planner" ? "the advisors file, if the rig has one" : wKind ? "as the workers: " + asWorkers : "as the workers");
      if (kind === "claude") claude += sessions[role] || 1;
      if (kind === "chatgpt") chatgpt += sessions[role] || 1;
    }
    const share = document.getElementById("share");
    if (share) {
      share.hidden = !claude && !chatgpt;
      const parts = [];
      if (claude) parts.push(claude + " can use a Claude subscription");
      if (chatgpt) parts.push(chatgpt + " can use a ChatGPT subscription");
      share.textContent = parts.length ? "One subscription, many agents: on this rig, of the agent sessions that run at once, up to " + parts.join(" and ") + ". Other rigs may use them too. When a plan is full, these agents wait; nothing pays for more." : "";
    }
  };
  const say = () => {
    runsIn();
    const out = [];
    for (const [el, was] of start) {
      if (el.type === "checkbox" && el.dataset.part !== undefined) {
        const st = el.closest(".pt").querySelector(".pt-state");
        st.textContent = el.checked ? "on" : "off"; st.className = "pt-state " + (el.checked ? "on" : "off");
        if (el.checked !== was) out.push("You turn " + (el.checked ? "on" : "off") + " the " + el.dataset.name.toLowerCase() + ".");
      } else if (el.type === "radio") {
        if (el.checked && !was) out.push("You change when a change becomes the champion: " + el.closest("label").querySelector("b").textContent.toLowerCase() + ".");
      } else if (el.tagName === "SELECT" || el.type === "number") {
        if (el.value !== was) out.push("You change " + label(el) + " to " + (el.value === "" ? (el.name === "choice" ? "its own settings" : "no limit") : el.options ? el.options[el.selectedIndex].textContent : el.value) + ".");
        if (el.value !== was && el.dataset.restarts !== undefined) out.push("The rig's harness restarts to regroup its GPUs: running trials and judge jobs start again.");
      }
    }
    const ul = document.getElementById("chg");
    ul.replaceChildren();
    for (const t of out.length ? out : ["Nothing changes."]) { const li = document.createElement("li"); li.textContent = t; ul.append(li); }
    document.getElementById("save").disabled = !out.length;
  };
  form.addEventListener("change", say);
  form.addEventListener("input", say);
  say();
})();
`;
