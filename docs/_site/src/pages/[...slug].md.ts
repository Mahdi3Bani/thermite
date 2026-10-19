// A Markdown copy of every page, at the page's address with `.md` at the end, for agents and for
// anyone who wants the source. Relative links between pages keep working, because the copies sit
// in the same tree as the pages they link to.
import type { APIRoute, GetStaticPaths } from "astro";
import { type CollectionEntry, getCollection } from "astro:content";

export const getStaticPaths = (async () => {
  const pages = await getCollection("docs", (page) => page.id !== "404");
  return pages.map((page) => ({ params: { slug: page.id }, props: { page } }));
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ page: CollectionEntry<"docs"> }> = ({ props }) => {
  const { title, description } = props.page.data;
  // MDX pages start with imports, which mean nothing outside the site.
  const body = (props.page.body ?? "").replace(/^import .*\n/gm, "").trim();
  const text = `# ${title}\n\n> ${description}\n\n${body}\n`;
  return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
