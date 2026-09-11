// SPDX-License-Identifier: AGPL-3.0-only
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        primary: '#4385e4',
        accent: '#7c3aed',
        dark: {
          900: '#050510',
          800: '#0a0a1a',
          700: '#0f0f2a',
          600: '#1a1a3e',
          500: '#252550'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace']
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
        'slide-up': 'slideUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out'
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(67, 133, 228, 0.3)' },
          '100%': { boxShadow: '0 0 20px rgba(67, 133, 228, 0.8), 0 0 40px rgba(67, 133, 228, 0.4)' }
        },
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: 0 },
          '100%': { transform: 'translateY(0)', opacity: 1 }
        },
        fadeIn: {
          '0%': { opacity: 0 },
          '100%': { opacity: 1 }
        }
      }
    }
  },
  plugins: []
}
