/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Sora', 'system-ui', 'sans-serif'],
      },
      colors: {
        vault: {
          bg: '#080a0f',
          surface: '#0e1117',
          border: '#1a2030',
          card: '#111827',
          teal: '#00d4aa',
          'teal-dim': '#00a688',
          cyan: '#22d3ee',
          red: '#f87171',
          muted: '#4b5563',
          text: '#e2e8f0',
          subtle: '#94a3b8',
        },
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        glow: {
          '0%': { boxShadow: '0 0 5px #00d4aa33' },
          '100%': { boxShadow: '0 0 20px #00d4aa66, 0 0 40px #00d4aa22' },
        },
      },
    },
  },
  plugins: [],
};
