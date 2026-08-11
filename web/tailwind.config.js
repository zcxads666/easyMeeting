/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"SF Pro Text"', '"PingFang SC"', '"Helvetica Neue"', 'sans-serif']
      },
      colors: {
        apple: { blue: '#0071e3', gray: '#f5f5f7', dark: '#1d1d1f', link: '#06c' }
      },
      borderRadius: { '2xl': '18px' }
    }
  },
  plugins: []
}