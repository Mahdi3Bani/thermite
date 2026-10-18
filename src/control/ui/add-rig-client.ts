/**
 * The Add a rig page's script, served from control (/ui/assets/add-rig.js; no inline script runs
 * under the dashboard's CSP). It shows the chosen place's GPU and resource choices and says, in a
 * sentence, what control will do. Without it the form still works: every place's choices show.
 */
export const ADD_RIG_JS = `
(() => {
  "use strict";
  const form = document.getElementById("add-rig");
  if (!form) return;
  const note = document.getElementById("gpu-note");
  const sum = document.getElementById("add-sum");
  const say = () => {
    const picked = form.querySelector('input[name="place"]:checked');
    const place = picked ? picked.value : "";
    for (const el of form.querySelectorAll("[data-place]")) {
      const on = el.dataset.place === place;
      el.hidden = !on;
      if (!on) for (const box of el.querySelectorAll('input[type="checkbox"]')) box.checked = false;
    }
    const name = form.elements.rig.value.trim() || "the rig";
    if (place.startsWith("cluster:")) {
      const k = place.slice(8);
      const get = (n) => { const el = form.elements[n + "__" + k]; return el ? el.value : ""; };
      const gpus = Number(get("k_gpus") || "0");
      const mode = get("k_mode");
      const how = mode.startsWith("dra:") ? "DRA (" + mode.slice(4) + ")" : "NVIDIA's device plugin";
      note.textContent =
        gpus === 0 ? "No GPU: the rig measures on the CPUs of its node." :
        gpus === 1 ? "One GPU through " + how + ": the judge and the agents share it, and the agents' test runs wait while the judge measures." :
        "Two GPUs through " + how + ": one for the judge, one for the agents' test runs.";
      const slot = get("k_slot");
      sum.textContent = "Control will enroll " + name + " and create it on " + k + (slot ? ", in the slot " + slot : ", in a namespace of its own") +
        ": a secret with its tokens, a " + (get("k_size") || "100") + " GB volume, and the harness and supervisor pods" + (gpus ? " with " + gpus + " GPU" + (gpus > 1 ? "s" : "") : "") +
        ". Then it waits for the rig's first report. You need to do nothing in the cluster.";
      return;
    }
    const gpus = [...form.querySelectorAll('input[name="gpus"]:checked')].map((x) => x.value).sort((a, b) => a - b);
    note.textContent =
      gpus.length === 0 ? "No GPU chosen: the rig measures on the machine's CPUs." :
      gpus.length === 1 ? "One GPU: the judge and the agents share GPU " + gpus[0] + ". While the judge measures, the agents' own test runs wait, so its timings stay clean." :
      gpus.length === 2 ? "GPU " + gpus[0] + " for the judge, GPU " + gpus[1] + " for the agents' test runs: they never wait for each other." :
      "A rig takes one or two GPUs for now. Rigs with more GPUs come with rigs of many GPUs.";
    const machine = place.startsWith("machine:") ? place.slice(8) : "";
    sum.textContent = machine
      ? "Control will enroll " + name + ", write its files and services on " + machine + (gpus.length ? " with GPU" + (gpus.length > 1 ? "s " + gpus.join(" and ") : " " + gpus[0]) : " (CPU only)") + ", start it, and wait for its first report. You need to do nothing on the machine."
      : "Choose a machine or a cluster.";
  };
  form.addEventListener("change", say);
  form.addEventListener("input", say);
  say();
})();
`;
