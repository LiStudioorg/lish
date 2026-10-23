/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // 暗黑主题调色板
        ink: {
          950: "#0b0d12",
          900: "#0f1218",
          850: "#141821",
          800: "#1a1f2b",
          700: "#242b3a",
        },
      },
    },
  },
  plugins: [],
};
