/**
 * The dashboard's icons: Thermite's flame, the same as the docs site's
 * (docs/_site/public/favicon.svg, and the favicon.ico and apple-touch-icon.png made from it;
 * icons.test.ts keeps them the same). Control serves them at the root, with no sign-in, so the
 * sign-in page has them too: browsers ask for /favicon.ico by themselves, and Safari takes no SVG.
 */

export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Thermite">\n  <path fill="#f0712a" d="M16 2c1.2 4.6 6.4 7.6 7.8 12.6 1.6 5.8-2.4 13.4-7.8 13.4S6.6 20.4 8.2 14.6C9 11.7 11 10 12.4 7.6c.6 2.6 1.8 4 3.2 4.6C15.2 8.8 15.4 5.4 16 2z"/>\n  <path fill="#ffd3b4" d="M16 15.2c.7 2.4 3.4 3.8 3.4 6.6 0 2.4-1.6 4.2-3.4 4.2s-3.4-1.8-3.4-4.2c0-1.6.9-2.6 1.6-3.6.3 1 .8 1.6 1.4 1.8-.3-1.8 0-3.4.4-4.8z"/>\n</svg>';

/** 16, 32 and 48 pixels, PNGs in an ICO. */
export const FAVICON_ICO = Buffer.from(
  "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",
  "base64",
);

/** 180 pixels, the flame on a dark square, for a page saved on iOS. */
export const APPLE_TOUCH_ICON = Buffer.from(
  "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",
  "base64",
);

/** The links every dashboard page's head has. */
export const ICON_LINKS =
  '<link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">';
