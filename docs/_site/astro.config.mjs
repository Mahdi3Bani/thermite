// @ts-check
// Thermite's documentation site. Pages live in src/content/docs/, one Diátaxis type each
// (src/content.config.ts). `npm run docs:build` at the repository root builds it into
// .dev/site/, and `npm run docs:check` checks what the build cannot.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";
import starlightLinksValidator from "starlight-links-validator";
import starlightLlmsTxt from "starlight-llms-txt";
import { pageIndex } from "./src/page-index.mjs";
import { remarkRelativeLinks } from "./src/plugins/remark-relative-links.mjs";

const site = "https://iammrduncan.github.io";
const base = "/thermite";
const repo = "https://github.com/iammrduncan/thermite";

export default defineConfig({
  site,
  base,
  outDir: "../../.dev/site",
  vite: {
    // Mermaid is one large script, loaded only on pages with a diagram.
    build: { chunkSizeWarningLimit: 4096 },
  },
  markdown: {
    // Pages link to each other with relative `.md` paths, so the links also work on GitHub and
    // in the Markdown copies. This turns them into site addresses.
    remarkPlugins: [[remarkRelativeLinks, { base }]],
  },
  integrations: [
    // astro-mermaid must come before Starlight.
    mermaid({ theme: "neutral", autoTheme: true }),
    starlight({
      title: "Thermite",
      description:
        "Thermite runs research campaigns with AI agents. Agents propose changes; code they cannot touch measures them, judges them and keeps the best.",
      logo: { src: "./src/assets/logo.svg", alt: "Thermite" },
      favicon: "/favicon.svg",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/docs/_site/` },
      lastUpdated: true,
      customCss: ["./src/styles/custom.css"],
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: [
        { label: "Start here", link: "/start-here/" },
        { label: "Tutorials", items: [{ autogenerate: { directory: "tutorials" } }] },
        {
          label: "How-to guides",
          items: [
            { label: "Install and rigs", items: [{ autogenerate: { directory: "how-to/install" } }] },
            { label: "Models", items: [{ autogenerate: { directory: "how-to/models" } }] },
            {
              label: "Campaigns and kits",
              items: [{ autogenerate: { directory: "how-to/campaigns" } }],
            },
            { label: "Operate", items: [{ autogenerate: { directory: "how-to/operate" } }] },
            { label: "Automate", items: [{ autogenerate: { directory: "how-to/automate" } }] },
          ],
        },
        {
          label: "Reference",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference" } }],
        },
        {
          label: "Explanation",
          collapsed: true,
          items: [{ autogenerate: { directory: "explanation" } }],
        },
        { label: "Project", collapsed: true, items: [{ autogenerate: { directory: "project" } }] },
      ],
      plugins: [
        starlightLinksValidator({
          // Relative links are turned into site addresses before the validator sees them.
          errorOnRelativeLinks: false,
          // Tutorials link to the dashboard on the reader's own computer.
          errorOnLocalLinks: false,
        }),
        starlightLlmsTxt({
          projectName: "Thermite",
          exclude: ["404"],
          description:
            "Thermite is an autoresearch harness. AI agents propose changes to a project; a judge the agents cannot touch measures each change and keeps the best. Many campaigns run at once on a fleet of rigs, and one control service shows and steers all of them.",
          details: pageIndex({ site, base }),
          customSets: [
            {
              label: "Tutorials",
              paths: ["tutorials/**"],
              description: "learn Thermite by doing, one path each",
            },
            {
              label: "How-to guides",
              paths: ["how-to/**"],
              description: "the steps for one task each",
            },
            {
              label: "Reference",
              paths: ["reference/**"],
              description: "settings, files, commands, the API and MCP, described completely",
            },
            {
              label: "Explanation",
              paths: ["explanation/**"],
              description: "how Thermite works, and why",
            },
          ],
          optionalLinks: [
            {
              label: "Roadmap",
              url: `${repo}/blob/main/docs/plan/roadmap.md`,
              description: "what is planned, by version",
            },
          ],
        }),
      ],
    }),
  ],
});
