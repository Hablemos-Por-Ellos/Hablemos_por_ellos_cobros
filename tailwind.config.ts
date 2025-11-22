import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        "foundation-blue": "#4A8FD8",
        "foundation-green": "#4CBF9E",
        "foundation-warm": "#FF8A6A",
        "foundation-cream": "#F9FBFD"
      },
      fontFamily: {
        sans: ["'Poppins'", "'Nunito'", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 24px 50px rgba(12, 30, 65, 0.08)"
      },
      borderRadius: {
        "4xl": "2.25rem",
      },
    },
  },
  plugins: [],
};

export default config;
