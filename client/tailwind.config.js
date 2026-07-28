/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: 'rgb(var(--color-ink-950) / <alpha-value>)',
          900: 'rgb(var(--color-ink-900) / <alpha-value>)',
          800: 'rgb(var(--color-ink-800) / <alpha-value>)',
        },
        paper: {
          50: 'rgb(var(--color-paper-50) / <alpha-value>)',
          100: 'rgb(var(--color-paper-100) / <alpha-value>)',
          200: 'rgb(var(--color-paper-200) / <alpha-value>)',
          300: 'rgb(var(--color-paper-300) / <alpha-value>)',
          400: 'rgb(var(--color-paper-400) / <alpha-value>)',
          500: 'rgb(var(--color-paper-500) / <alpha-value>)',
        },
        stone: {
          50: 'rgb(var(--color-stone-50) / <alpha-value>)',
          100: 'rgb(var(--color-stone-100) / <alpha-value>)',
          200: 'rgb(var(--color-stone-200) / <alpha-value>)',
          300: 'rgb(var(--color-stone-300) / <alpha-value>)',
          400: 'rgb(var(--color-stone-400) / <alpha-value>)',
          500: 'rgb(var(--color-stone-500) / <alpha-value>)',
          600: 'rgb(var(--color-stone-600) / <alpha-value>)',
          700: 'rgb(var(--color-stone-700) / <alpha-value>)',
          800: 'rgb(var(--color-stone-800) / <alpha-value>)',
          900: 'rgb(var(--color-stone-900) / <alpha-value>)',
        },
        brand: {
          50: 'rgb(var(--color-brand-50) / <alpha-value>)',
          100: 'rgb(var(--color-brand-100) / <alpha-value>)',
          200: 'rgb(var(--color-brand-200) / <alpha-value>)',
          300: 'rgb(var(--color-brand-300) / <alpha-value>)',
          400: 'rgb(var(--color-brand-400) / <alpha-value>)',
          500: 'rgb(var(--color-brand-500) / <alpha-value>)',
          600: 'rgb(var(--color-brand-600) / <alpha-value>)',
          700: 'rgb(var(--color-brand-700) / <alpha-value>)',
          800: 'rgb(var(--color-brand-800) / <alpha-value>)',
          900: 'rgb(var(--color-brand-900) / <alpha-value>)',
        },
        bordeaux: {
          700: 'rgb(var(--color-signal-700) / <alpha-value>)',
          800: 'rgb(var(--color-signal-800) / <alpha-value>)',
          900: 'rgb(var(--color-signal-900) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable"', '"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Segoe UI Variable Display"', '"Segoe UI"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Code"', '"SFMono-Regular"', 'Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
