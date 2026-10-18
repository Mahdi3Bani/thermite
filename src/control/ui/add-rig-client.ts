/**
 * The Add a rig page's script, served from control (/ui/assets/add-rig.js; no inline script runs
 * under the dashboard's CSP). It shows the chosen machine's GPUs and says, in a sentence, what
 * control will do. Without it the form still works: every machine's GPUs show.
 */
export const ADD_RIG_JS = `
(() => {
  "use strict";
  const form = document.getElementById("add-rig");
  if (!form) return;
  const note = document.getElementById("gpu-note");
  const sum = document.getElementById("add-sum");
  const say = () => {
    const picked = form.querySelector('input[name="machine"]:checked');
    const machine = picked ? picked.value : "";
    for (const el of form.querySelectorAll("[data-machine]")) {
      const on = el.dataset.machine === machine;
      el.hidden = !on;
      if (!on) for (const box of el.querySelectorAll("input")) box.checked = false;
    }
    const gpus = [...form.querySelectorAll('input[name="gpus"]:checked')].map((x) => x.value).sort((a, b) => a - b);
    const name = form.elements.rig.value.trim() || "the rig";
    note.textContent =
      gpus.length === 0 ? "No GPU chosen: the rig measures on the machine's CPUs." :
      gpus.length === 1 ? "One GPU: the judge and the agents share GPU " + gpus[0] + ". While the judge measures, the agents' own test runs wait, so its timings stay clean." :
      gpus.length === 2 ? "GPU " + gpus[0] + " for the judge, GPU " + gpus[1] + " for the agents' test runs: they never wait for each other." :
      "A rig takes one or two GPUs for now. Rigs with more GPUs come with rigs of many GPUs.";
    sum.textContent = machine
      ? "Control will enroll " + name + ", write its files and services on " + machine + (gpus.length ? " with GPU" + (gpus.length > 1 ? "s " + gpus.join(" and ") : " " + gpus[0]) : " (CPU only)") + ", start it, and wait for its first report. You need to do nothing on the machine."
      : "Choose a machine.";
  };
  form.addEventListener("change", say);
  form.addEventListener("input", say);
  say();
})();
`;
