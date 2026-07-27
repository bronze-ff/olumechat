/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0B1F2E', 900: '#0F2A3D', 800: '#163B54' },
        paper: { 50: '#faf8f5', 100: '#f7f4f0', 200: '#ede9e3', 300: '#e0dbd3', 400: '#c9c2b8', 500: '#a8a29e' },
        brand: {
          50: '#f0f7fb', 100: '#dbeef5', 200: '#b7dde9', 300: '#85c4d8', 400: '#4ea5c2',
          500: '#2e86ab', 600: '#1d6d8f', 700: '#1B5E7B', 800: '#1A5276', 900: '#154360',
        },
        bordeaux: { 700: '#9B1B1B', 800: '#8B1A1A', 900: '#7A1818' },
      },
      fontFamily: {
        sans: ['"DM Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"DM Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
