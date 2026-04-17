import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#f4f1e8",
        ink: "#1e1b16",
        panel: "#fdf9ef",
        accent: "#0f766e",
        alert: "#b45309",
        danger: "#b91c1c",
      },
      boxShadow: {
        panel: "0 18px 40px rgba(30, 27, 22, 0.12)",
      },
      fontFamily: {
        display: ["Georgia", "serif"],
        body: ["ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
