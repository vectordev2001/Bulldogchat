/** @type {import('tailwindcss').Config} */
// Scoped with the `bcw-` prefix per spec ("Use Tailwind with a scoped prefix
// (bcw-) OR ship a compiled CSS bundle. Prefer the latter"). We do both: the
// prefix means even if a consumer's own Tailwind build somehow also scans
// this package's source, there's zero class-name collision risk with
// Contracts/Ops's own utility classes; shipping the compiled dist/style.css
// means consumers don't need Tailwind configured at all to use the widget.
module.exports = {
  prefix: "bcw-",
  content: ["./src/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false, // never reset host app's global styles
  },
  theme: {
    extend: {
      colors: {
        "bcw-navy": "hsl(220, 55%, 14%)",
        "bcw-navy-light": "hsl(220, 45%, 25%)",
        "bcw-red": "hsl(0, 72%, 51%)",
      },
      boxShadow: {
        "bcw-panel": "0 20px 60px -10px rgba(0,0,0,0.45), 0 8px 20px -6px rgba(0,0,0,0.3)",
      },
    },
  },
  plugins: [],
};
