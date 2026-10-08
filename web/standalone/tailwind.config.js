import uiPreset from "@pcbjam/ui/tailwind-preset";

/** @type {import('tailwindcss').Config} */
export default {
  // Token colours, radii, dark mode and tailwindcss-animate come from @pcbjam/ui.
  presets: [uiPreset],
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../pcbjam-shared-ui/src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
  },
  plugins: [],
};
