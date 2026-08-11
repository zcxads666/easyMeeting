import { useEffect } from 'react';
import { Routes, Route, Link, NavLink, useLocation } from 'react-router-dom';
import { useStore } from './store';
import Home from './pages/Home.jsx';
import Meeting from './pages/Meeting.jsx';
import Summary from './pages/Summary.jsx';
import Settings from './pages/Settings.jsx';
import Models from './pages/Models.jsx';

const nav = [
  { to: '/', label: '会议' },
  { to: '/settings', label: '设置' },
  { to: '/models', label: '模型' }
];

export default function App() {
  const loadSettings = useStore((s) => s.loadSettings);
  const theme = useStore((s) => s.settings?.ui?.theme);

  useEffect(() => { loadSettings().catch(() => {}); }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="min-h-screen">
      <Nav />
      <main className="px-4 sm:px-8 max-w-5xl mx-auto pb-24">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/meeting/:id" element={<Meeting />} />
          <Route path="/summary/:id" element={<Summary />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/models" element={<Models />} />
        </Routes>
      </main>
    </div>
  );
}

function Nav() {
  const location = useLocation();
  return (
    <nav className="sticky top-0 z-40 backdrop-blur-xl bg-white/70 border-b border-black/5">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 h-12 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 font-semibold text-apple-dark">
          <span className="w-6 h-6 rounded-full bg-apple-blue text-white text-xs flex items-center justify-center">会</span>
          <span>会议纪要</span>
        </Link>
        <div className="flex items-center gap-1">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded-full text-sm transition-colors ${
                  isActive ? 'bg-apple-blue/10 text-apple-blue' : 'text-gray-600 hover:bg-black/5'
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </div>
      </div>
    </nav>
  );
}