import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: ['class'],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './store/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      
        brand: {
          sky: '#7ec8f2',
          skyDeep: '#3a9bd8',
          green: '#b6e3c8',
          greenDeep: '#6fc297',
          gold: '#f0dca0',
          goldDeep: '#d9b45c',
          ink: '#2b4a5e',
          inkSoft: '#5b7688',
          hlNum: '#d9a520',
          focusOrange: '#e8935a',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        pill: '999px',
        card: '22px',
      },
      boxShadow: {
        card: '0 8px 24px rgba(58, 155, 216, 0.08)',
        'card-hover': '0 14px 36px rgba(58, 155, 216, 0.14)',
        btn: '0 4px 14px rgba(58, 155, 216, 0.14)',
        'btn-hover': '0 8px 20px rgba(58, 155, 216, 0.20)',
      },
      backgroundImage: {
        topbar:
          'linear-gradient(90deg, rgba(214, 240, 255, 0.55), rgba(230, 247, 236, 0.55), rgba(251, 243, 221, 0.4))',
        'btn-grad': 'linear-gradient(135deg, #3a9bd8, #6fc297)',
        'btn-danger-grad': 'linear-gradient(135deg, #e88a7a, #d9534f)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'Noto Sans SC',
          'sans-serif',
        ],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
