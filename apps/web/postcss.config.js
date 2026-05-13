/**
 * PostCSS configuration for Next.js + Tailwind CSS.
 *
 * This file is REQUIRED — without it, Next.js doesn't run Tailwind on
 * globals.css, the @tailwind directives pass through unchanged, and the
 * whole app renders as unstyled HTML.
 *
 * The plugin order matters:
 *   1. tailwindcss — expands @tailwind directives + scans content paths
 *   2. autoprefixer — adds vendor prefixes for browser compatibility
 */
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
