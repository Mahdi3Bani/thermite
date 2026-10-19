import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

// Every page has a title, a one-line description and one Diátaxis type. The build fails without
// them. `npm run docs:check` also checks that each page sits in the section of its type.
export const collections = {
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        description: z.string().min(20),
        type: z.enum(["tutorial", "how-to", "reference", "explanation", "hub", "project"]),
      }),
    }),
  }),
};
