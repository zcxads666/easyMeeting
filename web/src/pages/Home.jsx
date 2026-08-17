import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { api } from '../api';

export default function Home() {
  const { meetings, loadMeetings, createMeeting, deleteMeeting, updateMeetingLocal } = useStore();
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => { loadMeetings(); }, []);

  const onCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const m = await createMeeting(title.trim());
      window.location.hash = `#/meeting/${m.id}`;
    } finally { setCreating(false); }
  };

  const filtered = search.trim()
    ? meetings.filter((m) =>
        (m.title || '').toLowerCase().includes(search.toLowerCase()) ||
        (m.rawText || '').toLowerCase().includes(search.toLowerCase()))
    : meetings;

  const togglePin = async (m, e) => {
    e.preventDefault();
    e.stopPropagation();
    const pinned = !m.pinned;
    updateMeetingLocal(m.id, { pinned });
    await api(`/meetings/${m.id}`, { method: 'PATCH', body: { pinned } }).catch(() => {});
    loadMeetings();
  };

  return (
    <div className="pt-16">
      <section className="text-center mb-12">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-3">会议纪要</h1>
        <p className="text-gray-500 dark:text-gray-400 text-lg">实时语音转写 · 智能梳理 · 本地安全保存</p>
      </section>

      <section className="card p-6 mb-10">
        <h2 className="text-lg font-semibold mb-4">新建会议</h2>
        <div className="flex gap-3">
          <input
            className="input flex-1"
            placeholder="会议主题，例如：季度产品评审会"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onCreate()}
          />
          <button className="btn-primary" onClick={onCreate} disabled={creating}>开始</button>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-4 gap-4">
          <h2 className="text-xl font-semibold">全部会议</h2>
          {meetings.length > 0 && (
            <input
              className="input max-w-xs"
              placeholder="🔍 搜索会议…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </div>
        {filtered.length === 0 ? (
          <div className="card p-12 text-center text-gray-400">
            <p className="text-4xl mb-3">{search ? '🔍' : '🎤'}</p>
            <p>{search ? '没有匹配的会议' : '还没有会议，创建一个开始记录吧'}</p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {filtered.map((m) => (
              <li key={m.id}>
                <MeetingCard
                  meeting={m}
                  onDelete={() => {
                    if (!confirm('确定删除该会议？')) return;
                    deleteMeeting(m.id);
                  }}
                  onPin={(e) => togglePin(m, e)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const STATUS_MAP = {
  idle: '待开始',
  recording: '记录中',
  transcribed: '已转写',
  summarized: '已总结',
  error: '失败'
};
const STATUS_COLOR = {
  recording: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  transcribed: 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400',
  summarized: 'bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400'
};

function MeetingCard({ meeting, onDelete, onPin }) {
  const segCount = meeting.segments?.length || 0;
  const minutes = Math.round((meeting.duration || 0) / 60);

  return (
    <div className="card p-5 hover:shadow-md transition-shadow group relative">
      <div className="flex items-start justify-between mb-3">
        <Link to={`/meeting/${meeting.id}`} className="flex-1 min-w-0">
          <h3 className="font-semibold text-lg mb-1 group-hover:text-apple-blue truncate">{meeting.title}</h3>
          <p className="text-gray-400 text-sm">
            {new Date(meeting.createdAt).toLocaleString('zh-CN')}
          </p>
        </Link>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onPin}
            className={`text-lg leading-none transition-opacity ${meeting.pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 hover:opacity-100'}`}
            title={meeting.pinned ? '取消置顶' : '置顶'}
          >
            {meeting.pinned ? '📌' : '📍'}
          </button>
          <span className={`text-xs px-2.5 py-1 rounded-full ${STATUS_COLOR[meeting.status] || 'bg-gray-100 dark:bg-white/10'}`}>
            {STATUS_MAP[meeting.status] || meeting.status}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-sm text-gray-500 dark:text-gray-400 mb-4">
        <span>{segCount} 段</span>
        {minutes > 0 && <span>{minutes} 分钟</span>}
        {meeting.summary && <span>{meeting.summary.topics?.length || 0} 议题</span>}
      </div>
      <div className="flex items-center gap-2">
        <Link to={`/meeting/${meeting.id}`} className="text-sm text-apple-blue hover:underline">继续记录</Link>
        {meeting.rawText && (
          <Link to={`/summary/${meeting.id}`} className="text-sm text-apple-blue hover:underline">查看纪要</Link>
        )}
        <button onClick={onDelete} className="ml-auto text-sm text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">删除</button>
      </div>
    </div>
  );
}
