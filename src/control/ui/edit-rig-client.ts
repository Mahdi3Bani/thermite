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
    const lb = el.closest(".fd") && el.closest(".fd").querySelector(".lb");
    return lb ? lb.firstChild.textContent.trim().toLowerCase() : el.name;
  };
  const say = () => {
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
