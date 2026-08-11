/** @type {import('tailwindcss').Config} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default {
  content: [
    path.resolve(__dirname, 'index.html'),
    path.resolve(__dirname, 'src/**/*.{js,jsx}')
  ],
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
