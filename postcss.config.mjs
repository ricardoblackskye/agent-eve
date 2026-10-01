/**
 * PostCSS configuration (#233).
 *
 * Tailwind v4 is CSS-first: the plugin is wired here and the stylesheet opts in
 * with `@import "tailwindcss"`. There is no `tailwind.config.js` — v4 reads its
 * configuration from CSS.
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
