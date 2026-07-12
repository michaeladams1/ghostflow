/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  // "class" (not "media") so the sun/moon toggle actually controls the theme,
  // rather than it being dictated by the OS setting. Default is light.
  darkMode: "class",
  theme: { extend: {} },
  plugins: [],
}
