import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';

export default function Home() {
  const { meetings, loadMeetings, createMeeting, deleteMeeting } = useStore();
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { loadMeetings(); }, []);

  const onCreate = async () => {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const m = await createMeeting(title.trim());
      window.location.hash = `#/meeting/${m.id}`;
    } finally { setCreating(false); }
  };

  return (
    <div className="pt-16">
      <section className="text-center mb-12">
        <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-3">会议纪要</h1>
        <p className="text-gray-500 text-lg">实时语音转写 · 智能梳理 · 本地安全保存</p>
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
        <h2 className="text-xl font-semibold mb-4">全部会议</h2>
        {meetings.length === 0 ? (
          <div className="card p-12 text-center text-gray-400">
            <p className="text-4xl mb-3">🎤</p>
            <p>还没有会议，创建一个开始记录吧</p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {meetings.map((m) => (
              <li key={m.id}>
                <MeetingCard meeting={m} onDelete={() => deleteMeeting(m.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function MeetingCard({ meeting, onDelete }) {
  const statusMap = {
    recording: '记录中',
    transcribed: '已转写',
    summarized: '已总结'
  };
  const statusColor = {
    recording: 'bg-blue-100 text-blue-600',
    transcribed: 'bg-green-100 text-green-600',
    summarized: 'bg-purple-100 text-purple-600'
  };
  const segCount = meeting.segments?.length || 0;
  const minutes = Math.round((meeting.duration || 0) / 60);

  return (
    <div className="card p-5 hover:shadow-md transition-shadow group">
      <div className="flex items-start justify-between mb-3">
        <Link to={`/meeting/${meeting.id}`} className="flex-1">
          <h3 className="font-semibold text-lg mb-1 group-hover:text-apple-blue">{meeting.title}</h3>
          <p className="text-gray-400 text-sm">
            {new Date(meeting.createdAt).toLocaleString('zh-CN')}
          </p>
        </Link>
        <span className={`text-xs px-2.5 py-1 rounded-full ${statusColor[meeting.status] || 'bg-gray-100'}`}>
          {statusMap[meeting.status] || meeting.status}
        </span>
      </div>
      <div className="flex items-center gap-4 text-sm text-gray-500 mb-4">
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