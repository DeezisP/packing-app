/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          950: 'rgb(var(--surface-950) / <alpha-value>)',
          900: 'rgb(var(--surface-900) / <alpha-value>)',
          850: 'rgb(var(--surface-850) / <alpha-value>)',
          800: 'rgb(var(--surface-800) / <alpha-value>)',
          700: 'rgb(var(--surface-700) / <alpha-value>)',
          600: 'rgb(var(--surface-600) / <alpha-value>)'
        },
        accent: {
          500: '#3b82f6',
          600: '#2563eb'
        },
        rec: {
          500: '#ef4444',
          600: '#dc2626'
        },
        ok: {
          500: '#22c55e'
        },
        warn: {
          500: '#f59e0b'
        }
      }
    }
  },
  plugins: []
}
