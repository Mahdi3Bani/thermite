---
title: "Credits"
description: "The research, systems, programs, libraries, standards and services Thermite draws on, runs or ships, each with its licence."
type: project
sidebar:
  order: 4
---

<!-- Written from CREDITS.md by `npm run docs:credits`: change CREDITS.md, not this page. -->

Thermite builds on other people's work. This list credits the research it learned from, the systems it studied, and the programs, libraries, standards and services it runs, ships or uses, each with its licence. It is kept in [`CREDITS.md`](https://github.com/iammrduncan/thermite/blob/main/CREDITS.md) at the root of Thermite's repository, and the documentation site shows it as its [Credits](https://usethermite.com/project/credits/) page.

- **What a licence here means.** For a paper, a post or a system that Thermite learned from, the licence is the work's own: Thermite cites it, and copies none of its text, code or data unless this list says so. For a program, a library or an image that Thermite runs or ships, the licence is the one it is used under.
- **Kept as the work goes on.** Every outside work that is studied, compared or used is added here in the same commit as the work it informed. A missing or a wrong credit is a bug: please [open an issue](https://github.com/iammrduncan/thermite/issues).

## Research behind the design

### Papers Thermite adopts from

| Work | Authors | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Stateless Language Agents: Scaling Long-Horizon Automated Research](https://arxiv.org/abs/2610.07625) (2026) | Zhang, Ji, Sun et al. | CC BY 4.0 | The shape of the agents: the harness owns all research state, every agent call starts fresh from context the harness builds, workers are isolated, and a stateless central planner assigns their experiments. Also the lane's keep rule, re-seeding lanes from the champion, and the registry of directions |
| [Fork-and-Flush: Escaping Idea Basins in Autoresearch Agents](https://arxiv.org/abs/2610.07447) (2026) | Cai, Ziakas, Kontonis et al. | CC BY 4.0 | Fork rounds on a fixed schedule: every lane starts again from the champion at a third and two thirds of the wall budget, never on a plateau trigger |
| [CORAL: Towards Autonomous Multi-Agent Evolution for Open-Ended Discovery](https://arxiv.org/abs/2604.01658) (2026) | Qu, Zheng, Zhou et al. | CC BY 4.0 | The loop inside a lane: a grader outside the agents that scores the exact commit in its own checkout, attempt records, heartbeats, the lineage view, and forking from another lane's best. Its lanes that share everything were weighed against Stateless Language Agents and not taken |
| [Risk-aware product decisions in A/B tests with multiple metrics](https://arxiv.org/abs/2402.11609) (2024), and Spotify Engineering's [post](https://engineering.atspotify.com/2024/3/risk-aware-product-decisions-in-a-b-tests-with-multiple-metrics) on it | Schultzberg, Ankargren, Frånberg | CC BY 4.0; the post © Spotify AB | Guards as non-inferiority tests: the objective must improve, and every guard must stay within its margin, for each step and over all promotions |
| [AutoResearch: An Execution-Grounded Multi-Agent Framework for Reliable Research Workflow Automation](https://arxiv.org/abs/2607.02520) (2026), whose second version introduces its Transactional Research Ledger | Kumar, Ali, Ahmed et al. | CC BY 4.0 | From the Transactional Research Ledger, the ledger's lifecycle: `invalidated` kept apart from `failed`, `superseded`, and promotion by compare-and-swap |
| [How Do Agents Fail on AutoResearch: End-to-End Diagnostic Evaluation on 100 Real-World Frontier Research Tasks](https://arxiv.org/abs/2608.14905) (2026), with its benchmark [AutoResearchEval](https://huggingface.co/datasets/PrentisAI/AutoResearchEval) | Fei, Liu, Yu et al. | CC BY 4.0; the dataset CC BY 4.0 | Evidence that agents game the judges they can reach, and its failure taxonomy (ARFT): flaws a worker declares stop a promotion, and submissions are counted |
| [AutoResearch: Insight In, Hallucination Out](https://arxiv.org/abs/2608.17906) (2026), EvoMap | Liu, Sun et al. | arXiv non-exclusive licence | From its code: fenced leases, a job blocked after a few lost leases, and completion that the engine decides, not an agent |
| [Agentic, autonomous design evolution of machine-learned interatomic potentials](https://doi.org/10.26434/chemrxiv.15003852/v1) (2026), chemRxiv | Lu, Chen, Yu, Jiang, Chen | CC BY-NC-ND 4.0 | An unchanged control in each batch, and every override kept as an attributed record |
| [FML-bench: A Controlled Study of AI Research Agent Strategies from the Perspective of Search Dynamics](https://arxiv.org/abs/2605.17373) (2026) | Zou, Lam, Zhao et al. | arXiv non-exclusive licence | With the next row, the evidence that the grader matters more than the search method |
| [Automated Discovery Has No Universally Superior Harness](https://arxiv.org/abs/2607.18235) (2026) | Gupta, Lei, Lu et al. | arXiv non-exclusive licence | The same |

### Measurement and statistics

The judge's verdicts rest on paired, interleaved blocks timed on log ratios, Student's t intervals, a few planned looks with the error rate split between them (Bonferroni), an equivalence band for `neutral`, a noise floor from A/A runs, and confirmation on fresh blocks. These works shaped that design.

| Work | Authors | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Equivalence Testing for Psychological Research: A Tutorial](https://doi.org/10.1177/2515245918770963) (2018), AMPPS | Lakens, Scheel, Isager | CC BY, open access | Equivalence testing (two one-sided tests): the equivalence band behind the `neutral` verdict |
| [Always Valid Inference: Bringing Sequential Analysis to A/B Testing](https://arxiv.org/abs/1512.04922) (2015), and [Peeking at A/B Tests: Why it matters, and what to do about it](https://doi.org/10.1145/3097983.3097992) (KDD 2017) | Johari, Pekelis, Walsh; Johari, Koomen, Pekelis, Walsh | arXiv non-exclusive licence; © ACM | Why looks at the data must be planned: the judge looks after 3, 6 and 9 blocks, with the error rate split between them |
| [Discrete Sequential Boundaries for Clinical Trials](https://doi.org/10.1093/biomet/70.3.659) (1983), Biometrika | Lan, DeMets | © Biometrika Trust | The same, group-sequential tests |
| [The Optimizer's Curse: Skepticism and Postdecision Surprise in Decision Analysis](https://doi.org/10.1287/mnsc.1050.0451) (2006), Management Science | Smith, Winkler | © INFORMS | Why a screened win is confirmed on fresh data before it counts |
| [Winner's Curse: Bias Estimation for Total Effects of Features in Online Controlled Experiments](https://doi.org/10.1145/3219819.3219905) (KDD 2018) | Lee, Shen | © ACM | The same |
| [Rigorous Benchmarking in Reasonable Time](https://doi.org/10.1145/2464157.2464160) (ISMM 2013) | Kalibera, Jones | © ACM | Repeats as separate processes, interleaved, and the noise of a machine measured, not assumed |
| [Scientific Benchmarking of Parallel Computing Systems: Twelve Ways to Tell the Masses when Reporting Performance Results](https://doi.org/10.1145/2807591.2807644) (SC'15) | Hoefler, Belli | © ACM | The same |
| [Robust Benchmarking in Noisy Environments](https://arxiv.org/abs/1608.04295) (2016) | Chen, Revels | arXiv non-exclusive licence | The same |
| [Producing Wrong Data Without Doing Anything Obviously Wrong!](https://doi.org/10.1145/1508244.1508275) (ASPLOS 2009) | Mytkowicz, Diwan, Hauswirth, Sweeney | © ACM | Why the change and the champion are timed in the same job, on the same device, in random order |
| [Generalization in Adaptive Data Analysis and Holdout Reuse](https://arxiv.org/abs/1506.02629) (2015) | Dwork, Feldman, Hardt et al. | arXiv non-exclusive licence | Held-out cases that no agent sees, checked only when a change is confirmed |
| [Trustworthy Online Controlled Experiments](https://doi.org/10.1017/9781108653985) (2020), a book | Kohavi, Tang, Xu | © Cambridge University Press | A/A tests, and Twyman's law: a surprising gain is checked before it is believed (the auditor's trigger) |
| [An Efficient Constraint Handling Method for Genetic Algorithms](https://doi.org/10.1016/S0045-7825(99)00389-8) (2000), CMAME | Deb | © Elsevier | Feasibility first: hard constraints are checked before the objective |
| [A Precision Approximation of the Gamma Function](https://doi.org/10.1137/0701008) (1964), SIAM J. Numer. Anal. B | Lanczos | © SIAM | The Lanczos approximation, with g = 7, behind the judge's t distribution (`src/core/stats.ts`) |
| [Generating Bessel Functions in Mie Scattering Calculations Using Continued Fractions](https://doi.org/10.1364/AO.15.000668) (1976), Applied Optics, and [Coulomb and Bessel Functions of Complex Arguments and Order](https://doi.org/10.1016/0021-9991(86)90046-X) (1986), J. Comput. Phys. | Lentz; Thompson, Barnett | © Optica; © Elsevier | The modified Lentz method for continued fractions, behind the incomplete beta function (`src/core/stats.ts`) |

[SciPy](https://github.com/scipy/scipy) and [NumPy](https://github.com/numpy/numpy) (both BSD-3-Clause) computed the reference values the statistics tests compare with (`scripts/stats-reference.py`); only the numbers are in the repository.

### Kernel evaluation and reward hacking

These showed that an agent graded by something it can reach will find a way to game it. They are why the judge owns the seeds, the reference, the timer and the result channel, why a candidate runs in its own process, and why Thermite has an auditor.

| Work | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [KernelBench: Can LLMs Write Efficient GPU Kernels?](https://arxiv.org/abs/2502.10517) (2025), and [its code](https://github.com/ScalingIntelligence/KernelBench) | Ouyang, Guo, Arora et al.; Stanford Scaling Intelligence Lab | CC BY 4.0; code MIT | How kernel candidates game a benchmark, and how a benchmark checks correctness |
| [KernelBench-Verified: Do LLM-Generated Kernels Actually Beat PyTorch?](https://arxiv.org/abs/2607.16241) (2026), and [its code](https://github.com/facebookresearch/kernel_bench_verified) | Zhang, Yu, Wang et al.; Meta | CC BY 4.0; code MIT | Stricter checks of a kernel's result |
| Sakana AI's [The AI CUDA Engineer](http://web.archive.org/web/20250223061804/https://sakana.ai/ai-cuda-engineer/) (February 2025, archived), whose update says the system had found a memory exploit in the evaluation code; TechCrunch's [report](https://techcrunch.com/2025/02/21/sakana-walks-back-claims-that-its-ai-can-dramatically-speed-up-model-training/) on it; and the follow-up, [Towards Robust Agentic CUDA Kernel Benchmarking, Verification, and Optimization](https://arxiv.org/abs/2509.14279) (robust-kbench, 2025) | Sakana AI; Kyle Wiggers; Lange, Sun, Prasad et al. | © Sakana AI; © TechCrunch; the paper CC BY 4.0 | A judge outside the candidate's reach, and checks that the changed code really ran |
| [Hardening Agent Benchmarks with Adversarial Hacker-Fixer Loops](https://arxiv.org/abs/2606.08960) (2026) | Zhong, Segal, Bercovich et al. | CC BY 4.0 | The same |
| [Measuring Automated Kernel Engineering](https://metr.org/blog/2025-02-14-measuring-automated-kernel-engineering/) and [Recent Frontier Models Are Reward Hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking/) (2025), posts | Tao Lin; Von Arx, Chan, Barnes; METR | © METR | The same |
| [GPU MODE kernelbot](https://github.com/gpu-mode/kernelbot) and [reference kernels](https://github.com/gpu-mode/reference-kernels) | GPU MODE | June 9 Researcher Reciprocity License 1.0 (MIT before 2026-06-09) | How a kernel competition scores and checks submissions |
| [nvbench](https://github.com/NVIDIA/nvbench), [CUTLASS](https://github.com/NVIDIA/cutlass)'s profiler, [Triton](https://github.com/triton-lang/triton)'s autotuner, [Kernel Tuner](https://github.com/KernelTuner/kernel_tuner) | NVIDIA; the Triton project; the Kernel Tuner project | Apache-2.0; BSD-3-Clause; MIT; Apache-2.0 | How kernels are timed and tuned |
| [TVM](https://github.com/apache/tvm) and its papers: [TVM](https://arxiv.org/abs/1802.04799) (OSDI 2018), [Learning to Optimize Tensor Programs](https://arxiv.org/abs/1805.08166) (AutoTVM), [Ansor](https://arxiv.org/abs/2006.06762), and [Tensor Program Optimization with Probabilistic Programs](https://arxiv.org/abs/2205.13603) (MetaSchedule) | The Apache Software Foundation; Chen et al.; Zheng et al.; Shao et al. | Apache-2.0; the papers arXiv non-exclusive licence | Search over program variants, measured on the device |

### Agent harness practice

| Work | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), a post | Anthropic | © Anthropic | Read on long agent work across many context windows, kept in files and git rather than in one conversation |
| [Infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise), a post | Anthropic | © Anthropic | Read on how the machine's noise moves an agent evaluation's results |
| [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) (2025), a post | Walden Yan, Cognition | © Cognition | Read on agents that split one task between them. Thermite's workers each own a whole experiment, and one planner coordinates them |
| [Ralph Wiggum as a "software engineer"](https://ghuntley.com/ralph/), a post | Geoffrey Huntley | © Geoffrey Huntley | Read: the plain loop that runs an agent again and again on one task |
| [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), a gist | Andrej Karpathy | No licence stated | Read: a knowledge base that agents read and add to |

## Systems Thermite studied

### Autoresearch systems

Thermite's research started from [awesome-autoresearch](https://github.com/WecoAI/awesome-autoresearch) (Weco AI, CC0-1.0), a list of autoresearch projects.

| System | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| [autoresearch](https://github.com/karpathy/autoresearch), and its [`agenthub`](https://github.com/karpathy/autoresearch/tree/agenthub) branch | Andrej Karpathy | The README says MIT; there is no LICENSE file | The loop Thermite generalizes: an agent changes code, a run measures it, the best is kept. Thermite moves judging out of the agent's reach and keeps every discard. From `agenthub`: queries over a run's lineage |
| [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) | David Cortés, Tobi Lütke | MIT | The closest earlier method. Its lessons are what Thermite fixes: verdicts an agent writes, resets that destroy work, and fixed caps on turns and discards |
| [autoresearch](https://github.com/uditgoenka/autoresearch) | Udit Goenka | MIT | The statistics of a regression gate, and the fork round every 20 epochs when a run has no wall budget |
| [evo](https://github.com/evo-hq/evo) | evo-hq | Apache-2.0 | Gates that pass down to child experiments, the held-out floor, and an experiment's brief in four parts; invalidating a node invalidates what grew from it |
| [AutoKernel](https://github.com/RightNow-AI/autokernel), and [its paper](https://arxiv.org/abs/2603.21331) | RightNow AI | MIT; CC BY 4.0 | Correctness checks in stages, a cache flush between timed runs, and roofline checks |
| [autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx) | trevin-creator | MIT | A keep gate that takes noise into account, and never scoring the same code twice |
| [autoresearch-at-home](https://github.com/mutable-state-inc/autoresearch-at-home) | mutable-state-inc | The README says MIT; there is no LICENSE file | How workers claim work so it is not done twice, and a key that says which results compare |
| [autoresearch-win-rtx](https://github.com/jsegov/autoresearch-win-rtx) | jsegov | The README says MIT; there is no LICENSE file | Compared |
| [OpenResearch](https://github.com/alphaXiv/OpenResearch) | alphaXiv | MIT | Research mode's first proposals: an experiment tree, and runs named by their content |
| [CORAL](https://github.com/Human-Agent-Society/CORAL) | Human Agent Society | Apache-2.0 | The code of the paper above |
| [ResearchLedger](https://github.com/raja21068/ResearchLedger) | Rajesh Kumar | MIT | The code of the Transactional Research Ledger |
| [AutoResearch](https://github.com/EvoMap/AutoResearch) | EvoMap | Apache-2.0 | The code of its paper above |
| [AutoResearchEval](https://github.com/PrentisAI/AutoResearchEval) | Prentis AI, Titan Research Labs | No licence for the whole; its `agent-as-a-judge/` folder is MIT | The code of its paper above |
| [AutoResearch-MLIP](https://github.com/pic-ai-robotic-chemistry/Agentic-auto-designed-MLIPs) | pic-ai-robotic-chemistry | No licence stated | The code of its paper above |
| [Agon](https://github.com/AutoResearch-Factory/Agon), and [its paper](https://arxiv.org/abs/2606.24177) | AutoResearch Factory | MIT; arXiv non-exclusive licence | Compared |
| [SimplexFold](https://github.com/ChrisHayduk/SimplexFold), [agent-digivolve-harness-loop](https://github.com/MatthewZMD/agent-digivolve-harness-loop), [auto-agent](https://github.com/alfonsograziano/auto-agent) | Chris Hayduk; Matthew Zeng; Alfonso Graziano | MIT each | Their research protocols and verified reporting, read for ideas |

### Program-evolution and research-agent systems

Thermite studied these and took none of them as its engine. Searching a population, or keeping a Pareto set of champions, is a proposed goal ([051](https://github.com/iammrduncan/thermite/blob/main/docs/plan/goals/051-pareto-and-population.goal)), not built.

| System | By | Licence | What Thermite takes from it |
| --- | --- | --- | --- |
| FunSearch: [Mathematical discoveries from program search with large language models](https://doi.org/10.1038/s41586-023-06924-6) (Nature, 2023), and [its code](https://github.com/google-deepmind/funsearch) | Romera-Paredes et al.; Google DeepMind | Paper: CC BY 4.0; code Apache-2.0, other material CC BY 4.0 | An evaluator that code owns, and a program database |
| [AlphaEvolve: A coding agent for scientific and algorithmic discovery](https://arxiv.org/abs/2506.13131) (2025), and [its results](https://github.com/google-deepmind/alphaevolve_results) | Novikov et al.; Google DeepMind | CC BY-NC-ND 4.0; results Apache-2.0 and CC BY 4.0 | Evolving code against automated evaluators |
| [OpenEvolve](https://github.com/algorithmicsuperintelligence/openevolve) | Asankhaya Sharma | Apache-2.0 | Compared; also a lesson in evaluator integrity: a change its own benchmark never applied |
| [ShinkaEvolve: Towards Open-Ended And Sample-Efficient Program Evolution](https://arxiv.org/abs/2509.19349) (2025), and [its code](https://github.com/SakanaAI/ShinkaEvolve) | Lange, Imajuku, Cetin; Sakana AI | CC BY 4.0; code Apache-2.0 | Compared: sample-efficient evolution |
| [EvoX: Meta-Evolution for Automated Discovery](https://arxiv.org/abs/2602.23413) (2026), and its code, [SkyDiscover](https://github.com/skydiscover-ai/skydiscover) | Liu, Agarwal, Maheswaran et al. | CC BY 4.0; code Apache-2.0 | Compared |
| [CodeEvolve](https://arxiv.org/abs/2510.14150) (2025), and [its code](https://github.com/inter-co/science-codeevolve) | Assumpção, Ferreira, Campos et al.; Inter&Co | arXiv non-exclusive licence; code Apache-2.0 | Compared |
| [PACEvolve](https://arxiv.org/abs/2601.10657), [DeltaEvolve](https://arxiv.org/abs/2602.02919) and [KernelEvolve](https://arxiv.org/abs/2512.23236) | Their authors | CC BY 4.0 each | Compared |
| [LLM4AD](https://github.com/Optima-CityU/LLM4AD) and [LLM4AD_Next](https://github.com/Optima-CityU/LLM4AD_Next) | Optima, City University of Hong Kong | BSD-2-Clause; BSD-3-Clause | Compared |
| [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457) (2025), and [its code](https://github.com/gepa-ai/gepa) | Agrawal, Tan, Soylu et al. | arXiv non-exclusive licence; code MIT | Pareto selection between candidates |
| [Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents](https://arxiv.org/abs/2505.22954) (2025), and [its code](https://github.com/jennyzzt/dgm) | Zhang, Hu, Lu et al. | CC BY 4.0; code Apache-2.0 | Keeping every variant, not only the best |
| [MAP-Elites: Illuminating search spaces by mapping elites](https://arxiv.org/abs/1504.04909) (2015) | Mouret, Clune | arXiv non-exclusive licence | Quality diversity, for the proposed population search |
| [The AI Scientist](https://arxiv.org/abs/2408.06292) and [The AI Scientist-v2](https://arxiv.org/abs/2504.08066), with [their](https://github.com/SakanaAI/AI-Scientist) [code](https://github.com/SakanaAI/AI-Scientist-v2) | Lu, Lu, Lange et al.; Yamada, Lange, Lu et al.; Sakana AI | CC BY 4.0; code under the AI Scientist Source Code License 1.0, not used | Compared; their code's licence is why none of it is used |
| [AIDE: AI-Driven Exploration in the Space of Code](https://arxiv.org/abs/2502.13138) (2025), and [aideml](https://github.com/WecoAI/aideml) | Jiang, Schmidt, Srikanth et al.; Weco AI | CC BY 4.0; code MIT | A tree of solutions, each with its result |
| [MLAgentBench](https://github.com/snap-stanford/MLAgentBench), [RD-Agent](https://github.com/microsoft/RD-Agent), [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory), [AgentRxiv](https://arxiv.org/abs/2503.18102) | Stanford SNAP; Microsoft; Samuel Schmidgall; Schmidgall, Moor | MIT each; AgentRxiv CC BY 4.0 | Their workflows, compared |
| [AIRA-dojo](https://github.com/facebookresearch/aira-dojo), and its paper, [AI Research Agents for Machine Learning: Search, Exploration, and Generalization in MLE-bench](https://arxiv.org/abs/2507.02554) (2025) | Toledo, Hambardzumyan, Josifoski et al.; Meta | CC BY-NC 4.0; CC BY-NC-SA 4.0 | Compared only; its code's licence is non-commercial, and none of it is used |
| [SwarmResearch: Orchestrating Coding Agents for Open-Ended Discovery](https://arxiv.org/abs/2607.02807), [MOAE: Multi-Objective Agent Evolution with Pareto-Preserving Search](https://arxiv.org/abs/2609.05992), [AIRA₂: Overcoming Bottlenecks in AI Research Agents](https://arxiv.org/abs/2603.26499), [AI-Research Agents in the Wild](https://arxiv.org/abs/2609.11975), and the survey [AutoResearch AI: Towards AI-Powered Research Automation for Scientific Discovery](https://arxiv.org/abs/2605.23204) (2026 each) | Virk et al.; Jiang et al.; Hambardzumyan et al.; Komissarov, Ustyuzhanin; Tie et al. | CC BY 4.0, except MOAE: arXiv non-exclusive licence | Read and compared; the survey for its vocabulary |

### Coding agents compared

[OpenHands Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) (MIT) and [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (MIT) were compared as worker harnesses. Neither was taken.

### Fleet, rig and tracking tools compared

Thermite compared these from their public documentation. It uses none of their code.

- **Adding and managing rigs:** [herdr](https://github.com/herdrdev/herdr) (Apache-2.0), whose consent before it installs anything on a machine, and its pinned host keys, are the model for **Add a rig**. Also [SkyPilot](https://github.com/skypilot-org/skypilot) (Apache-2.0), [dstack](https://github.com/dstackai/dstack) (MPL-2.0), [Coder](https://github.com/coder/coder) (AGPL-3.0), [Gitpod and Ona](https://github.com/gitpod-io/gitpod) (AGPL-3.0), [Rancher](https://github.com/rancher/rancher) and [Fleet](https://github.com/rancher/fleet) (Apache-2.0), [the Argo CD agent](https://github.com/argoproj-labs/argocd-agent) (Apache-2.0), [Portainer](https://github.com/portainer/portainer) (Zlib), [Kamal](https://github.com/basecamp/kamal) (MIT), [Coolify](https://github.com/coollabsio/coolify) (Apache-2.0), [CapRover](https://github.com/caprover/caprover) (Apache-2.0), [Dokku](https://github.com/dokku/dokku) (MIT), [disco](https://github.com/letsdiscodev/disco-daemon) (MIT), [Ansible](https://github.com/ansible/ansible) (GPL-3.0), [KubeRay](https://github.com/kuberay-project/kuberay), [Kueue](https://github.com/kubernetes-sigs/kueue), [Determined](https://github.com/determined-ai/determined), [Volcano](https://github.com/volcano-sh/volcano) and [HAMi](https://github.com/Project-HAMi/HAMi) (Apache-2.0 each), NVIDIA Run:ai, [GitHub's Actions Runner Controller](https://github.com/actions/actions-runner-controller) (Apache-2.0), GitLab Runner, [Buildkite's agent stack for Kubernetes](https://github.com/buildkite/agent-stack-k8s) (MIT), and [Tailscale](https://github.com/tailscale/tailscale)'s auth keys (BSD-3-Clause). From them: join tokens swapped on first contact, and slots scoped to a namespace.
- **Orchestration and experiment tracking:** [Temporal](https://github.com/temporalio/temporal) (MIT), [Ray](https://github.com/ray-project/ray) and Ray Tune (Apache-2.0), [Optuna](https://github.com/optuna/optuna) (MIT), [Ax](https://github.com/facebook/Ax) and [BoTorch](https://github.com/meta-pytorch/botorch) (MIT), [OSS Vizier](https://github.com/google/vizier) (Apache-2.0), [MLflow](https://github.com/mlflow/mlflow) (Apache-2.0), [Weights & Biases](https://github.com/wandb/wandb) (MIT), [Aim](https://github.com/aimhubio/aim) (Apache-2.0), [ClearML](https://github.com/clearml/clearml) (Apache-2.0), [NATS JetStream](https://github.com/nats-io/nats-server) (Apache-2.0) and [DBOS](https://github.com/dbos-inc/dbos-transact-py) (MIT). Thermite keeps its own ledger; Optuna's and Ax's data models informed the trial's.
- **Metrics:** [Prometheus](https://github.com/prometheus/prometheus) (Apache-2.0)'s advice on label cardinality: the record stays in the ledger, and metrics carry only bounded series.
- **Documentation tools:** [Docusaurus](https://github.com/facebook/docusaurus), [VitePress](https://github.com/vuejs/vitepress), [Material for MkDocs](https://github.com/squidfunk/mkdocs-material) and [Zensical](https://github.com/zensical/zensical) (MIT each). Starlight was chosen.

### Engines the earlier campaigns tuned

Thermite grew out of long hill-climbing campaigns on inference kernels. They tuned these engines, and the methods they taught (prove that the changed code ran, measure the noise of the device, check output against a reference) became the judge's. Thermite uses none of their code. The papers those campaigns read are in their own records, not here.

[llama.cpp and ggml](https://github.com/ggml-org/llama.cpp) (MIT), whose `test-backend-ops` and `llama-perplexity --kl-divergence` were the campaigns' correctness gates; [llamAmpere](https://github.com/JakeATX/llamAmpere) (MIT); [llama-cpp-p100-patches](https://github.com/shinbunbun/llama-cpp-p100-patches) (MIT); [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) (MIT); [ExLlamaV3](https://github.com/turboderp-org/exllamav3) (MIT); [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0); [SGLang](https://github.com/sgl-project/sglang) (Apache-2.0).

## Programs the agents run in

| Program | By | Licence | How Thermite uses it |
| --- | --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi): `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` | Mario Zechner, Earendil Works | MIT | Built into Thermite: the default worker harness, and the model client for the planner and Pi's workers |
| [OpenCode](https://github.com/anomalyco/opencode) | Anomaly | MIT | A worker harness, in the harness and supervisor images, with its licence at `/usr/local/share/doc/opencode/` |
| [Codex CLI](https://github.com/openai/codex) | OpenAI | Apache-2.0 | A worker harness, in the harness and supervisor images, with its LICENSE and NOTICE at `/opt/codex/`. Its NOTICE credits code derived from [Ratatui](https://github.com/ratatui/ratatui) (MIT, © 2016-2022 Florian Dehau, © 2023-2025 The Ratatui Developers) |
| [Claude Code](https://github.com/anthropics/claude-code) | Anthropic | Proprietary: © Anthropic PBC, all rights reserved; use is under Anthropic's Commercial Terms of Service | A worker harness, for a Claude subscription. It is in an image only when that image is built with `CLAUDE_CODE_VERSION`; no published image has it |

## In the images

| Software | By | Licence | Where |
| --- | --- | --- | --- |
| [Node.js](https://github.com/nodejs/node), from the [official `node` image](https://hub.docker.com/_/node) on Debian bookworm | The OpenJS Foundation and Node.js contributors | MIT, with the licences of what it bundles (V8, OpenSSL, SQLite and others) in its LICENSE file | Control, the harness and the supervisor. Thermite's ledgers and stores use Node's built-in SQLite |
| [CUDA](https://hub.docker.com/r/nvidia/cuda), from NVIDIA's `nvidia/cuda` devel image on Ubuntu 22.04 | NVIDIA | [NVIDIA Deep Learning Container License](https://developer.download.nvidia.com/licenses/NVIDIA_Deep_Learning_Container_License.pdf), and the licences of its open-source parts | The CUDA harness image, and the rig image built on it. NVIDIA's software in them stays under NVIDIA's licence, which anyone who pulls or runs those images accepts |
| [kubectl](https://github.com/kubernetes/kubernetes) | The Kubernetes Authors | Apache-2.0 | Control, with its licence at `/usr/local/share/doc/kubectl/LICENSE` |
| [tini](https://github.com/krallin/tini) | Thomas Orozco | MIT | Every image, as the first process |
| Debian and Ubuntu packages: git, GCC, GNU Make, CMake, Ninja, ccache, Python 3 with NumPy, OpenSSH's client, util-linux (setpriv, prlimit, taskset), CA certificates, unzip | Their projects, packaged by Debian and Ubuntu | Their own: for example GPL-2.0 for git, GPL-3.0-or-later with the GCC Runtime Library Exception for GCC, BSD-3-Clause for CMake and NumPy, Apache-2.0 for Ninja | The harness (to build and run kits) and control and the supervisor (git and SSH). Each package's terms are in `/usr/share/doc/<package>/copyright` in the image |

`thermite-devfence` (`containers/harness/devfence.c`) is Thermite's own code, built against the Linux kernel's Landlock interface.

## Libraries

### What Thermite runs

| Library | By | Licence | What it does in Thermite |
| --- | --- | --- | --- |
| [Hono](https://github.com/honojs/hono) and [@hono/node-server](https://github.com/honojs/node-server) | Yusuke Wada | MIT | The HTTP server and routes of control, the harness and the supervisor |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | The Model Context Protocol project (Anthropic) | MIT for the npm package Thermite uses; the repository is moving to Apache-2.0 | Control's MCP server, the harness's MCP gateway and the MCP client |
| [Zod](https://github.com/colinhacks/zod) | Colin McDonnell | MIT | Every schema: contracts, kits, commands, reports |
| Pi's packages, above | Mario Zechner | MIT | With their own dependencies, among them the AWS SDK for JavaScript, Google's Gen AI SDK, the OpenAI SDK (Apache-2.0 each) and protobuf.js (BSD-3-Clause) |

Every package Thermite runs, with those packages' own dependencies, is under a permissive licence: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD or the Unlicense. None is copyleft. `package-lock.json` lists each one, with its version.

### What builds and checks Thermite

[TypeScript](https://github.com/microsoft/TypeScript) (Microsoft, Apache-2.0), [Biome](https://github.com/biomejs/biome) (MIT OR Apache-2.0), [Node.js's type definitions](https://github.com/DefinitelyTyped/DefinitelyTyped) (MIT), and [gitleaks](https://github.com/gitleaks/gitleaks) (MIT) for the secret scan. CI uses GitHub's own actions (MIT) and Docker's (Apache-2.0).

### What builds the documentation site

| Library | By | Licence |
| --- | --- | --- |
| [Astro](https://github.com/withastro/astro) and [Starlight](https://github.com/withastro/starlight) | The Astro project; Chris Swithinbank | MIT |
| [Pagefind](https://github.com/Pagefind/pagefind) (search), [Expressive Code](https://github.com/expressive-code/expressive-code) and [Shiki](https://github.com/shikijs/shiki) (code blocks) | Their projects | MIT |
| [Mermaid](https://github.com/mermaid-js/mermaid) and [astro-mermaid](https://github.com/joesaby/astro-mermaid) (diagrams) | Knut Sveidqvist and contributors; Jose Sebastian | MIT. Mermaid's diagrams use [DOMPurify](https://github.com/cure53/DOMPurify), MPL-2.0 OR Apache-2.0, in the reader's browser |
| [starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator) and [starlight-llms-txt](https://github.com/delucis/starlight-llms-txt) | HiDeoo; Chris Swithinbank | MIT |
| [sharp](https://github.com/lovell/sharp) (images) | Lovell Fuller | Apache-2.0; its libvips binaries are LGPL-3.0-or-later, used only to build the site |
| [Lightning CSS](https://github.com/parcel-bundler/lightningcss), through Vite | The Parcel project | MPL-2.0, used only to build the site |

`docs/_site/package-lock.json` lists every package, with its licence and version.

## Design

- **The dashboard's look** follows [Magnesium](https://github.com/iammrduncan/magnesium) (MIT), the maintainers' agent dashboard, which is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT, © 2026 T3 Tools Inc.): its design tokens, its status words, its tiles and its session board. The colour values are those of [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss)'s palette (MIT).
- **The icons and the flame** are Thermite's own.

## Standards and guides

| Work | By | Licence | How Thermite uses it |
| --- | --- | --- | --- |
| [Diátaxis](https://diataxis.fr/) | Daniele Procida | © Daniele Procida; [its source](https://github.com/evildmp/diataxis-documentation-framework) is CC BY-SA 4.0 | The documentation site's four kinds of page |
| [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/), Issue 9 | ASD's Simplified Technical English Maintenance Group | © ASD, all rights reserved; a trademark of ASD; its notice forbids redistributing the standard without the group's written permission | The dashboard's decision cards and the reports are written after it. A research run's final paper is written in it, and checked against it by a checker the deployment provides (`THERMITE_STE_CHECKER`), whose guide the final writer reads when it has one; without a checker, the writer gets short rules in Thermite's own words. Thermite ships no checker, none of the standard's vocabulary and none of its text |
| [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) | The Organization for Ethical Source | CC BY 4.0 | Thermite's code of conduct, adopted by reference |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Anthropic and contributors | See the MCP TypeScript SDK, above | Control's MCP server, and the MCP servers a campaign's agents use |
| [llms.txt](https://llmstxt.org/) | Jeremy Howard, Answer.AI | No licence stated on the page; [its repository](https://github.com/AnswerDotAI/llms-txt) is Apache-2.0 | The site's `llms.txt` and `llms-full.txt` |
| [SPDX license expressions](https://spdx.dev/) and [OCI image annotations](https://github.com/opencontainers/image-spec) | The Linux Foundation; the Open Container Initiative | CC BY 3.0; Apache-2.0 | The licence labels on the published images |
| [Semantic Versioning](https://semver.org/) | Tom Preston-Werner | CC BY 3.0 | The release's version tags |
| IETF RFCs: Ed25519 ([RFC 8032](https://www.rfc-editor.org/rfc/rfc8032)), HKDF ([RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)), PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), dynamic client registration ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)), timestamps ([RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)), private addresses ([RFC 1918](https://www.rfc-editor.org/rfc/rfc1918)), robots.txt ([RFC 9309](https://www.rfc-editor.org/rfc/rfc9309)) | The IETF | The IETF Trust's licence | Signed commands, sealed secrets, MCP sign-in, and the research fetcher |
| AES-256-GCM ([NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)) | NIST | A U.S. government work | Sealed secrets |
| [Container Device Interface](https://github.com/cncf-tags/container-device-interface) (CDI) | The CNCF's Container Orchestrated Devices working group | Apache-2.0 | How Podman gives a rig's harness its NVIDIA GPUs, as `nvidia.com/gpu` devices: on machines that control sets rigs up on, and in the local stack's `compose.gpu.yaml` |

## Services Thermite works with

- **Model providers:** the APIs of [Anthropic](https://www.anthropic.com/) and [OpenAI](https://openai.com/), Claude and ChatGPT subscriptions, [OpenRouter](https://openrouter.ai/) and [Nous Portal](https://portal.nousresearch.com/) (whose model lists give prices), [OpenCode Zen](https://opencode.ai/zen), and any server with an OpenAI-compatible API, such as [Ollama](https://github.com/ollama/ollama), [vLLM](https://github.com/vllm-project/vllm) or [LiteLLM](https://github.com/BerriAI/litellm).
- **Compute and files:** [RunPod](https://www.runpod.io/), through its REST API and proxy; [Hugging Face](https://huggingface.co/), for model files.
- **A knowledge base, as an example of an MCP server:** [GBrain](https://github.com/garrytan/gbrain) (Garry Tan, MIT).
- **The project:** [GitHub](https://github.com/), for the repository, Actions, the container registry, Dependabot and private vulnerability reports; [Cloudflare Pages](https://pages.cloudflare.com/), which serves the documentation site; [Fathom Analytics](https://usefathom.com/), which counts the site's visits without cookies; [Discord](https://discord.com/), for the community; [shields.io](https://shields.io/), for the badges.
- **Images:** [Docker Hub](https://hub.docker.com/) for the base images, and [Quay](https://quay.io/) for a test image.

## Tools Thermite is tested with

[Podman](https://github.com/containers/podman), [Docker](https://www.docker.com/) and their compose tools; [Kubernetes](https://github.com/kubernetes/kubernetes) and [kind](https://github.com/kubernetes-sigs/kind) (Apache-2.0 each), with systemd's Quadlet units for rigs on machines; [NVIDIA's device plugin](https://github.com/NVIDIA/k8s-device-plugin) and [DRA driver](https://github.com/kubernetes-sigs/dra-driver-nvidia-gpu) (Apache-2.0); [NVIDIA's container toolkit](https://github.com/NVIDIA/nvidia-container-toolkit) (Apache-2.0), which gives containers the GPUs, through its runtime for Docker and its CDI spec for Podman, and which `thermite doctor` and `thermite local init` check for; Fedora's and Debian's images as stand-in machines; [uv](https://github.com/astral-sh/uv) (Apache-2.0 OR MIT) to run the statistics reference script; and Chrome, which takes the documentation's screenshots. A manual long-run test starts its research from two Wikipedia articles (CC BY-SA 4.0), which it fetches when it runs.

## The maintainers' own public projects

- [Magnesium](https://github.com/iammrduncan/magnesium) (MIT): the dashboard's design, above, and its notes on Claude and Codex sign-in, read for subscriptions.
- [skills](https://github.com/iammrduncan/skills) (MIT): the maintainers' skills for coding agents, among them the ones for Simplified Technical English and for writing documentation.

## What this repository holds from others

Thermite's repository holds no code, text or data copied from another project, except:

- the licence texts it ships with programs in its images: `containers/control/kubectl/LICENSE` (Apache-2.0, from Kubernetes), `containers/harness/opencode/LICENSE` (MIT, © 2025 opencode), and `containers/harness/codex/LICENSE` and `NOTICE` (Apache-2.0, © 2025 OpenAI, with the Ratatui notice above);
- the dashboard's colour tokens, from T3 Code through Magnesium, above;
- the statistics tests' reference values, numbers computed with SciPy (`src/testing/data/stats-reference.json`).

The maintainers' own tooling in `.agents/` carries its own notices, such as [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT).
