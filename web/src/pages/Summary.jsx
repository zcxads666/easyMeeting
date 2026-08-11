import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';

export default function Summary() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [summary, setSummary] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api(`/meetings/${id}`).then((m) => {
      setMeeting(m);
      setSummary(m.summary);
    }).catch(() => setError('加载失败'));
  }, [id]);

  const generateSummary = async () => {
    if (!meeting?.rawText) return;
    setGenerating(true);
    setError('');
    try {
      const { summary } = await api('/llm/summary', { method: 'POST', body: { text: meeting.rawText } });
      setSummary(summary);
      const updated = await api(`/meetings/${id}`, { method: 'PATCH', body: { summary, status: 'summarized' } });
      setMeeting(updated);
    } catch (e) {
      setError(e.message);
    } finally { setGenerating(false); }
  };

  const correctText = async () => {
    setCorrecting(true);
    setError('');
    try {
      const { corrected } = await api('/llm/correct', { method: 'POST', body: { text: meeting.rawText } });
      const updated = await api(`/meetings/${id}`, { method: 'PATCH', body: { corrected } });
      setMeeting(updated);
    } catch (e) { setError(e.message); }
    finally { setCorrecting(false); }
  };

  const copyText = () => {
    const text = buildMarkdown(meeting, summary);
    navigator.clipboard.writeText(text);
  };

  if (!meeting) return <div className="pt-24 text-center text-gray-400">加载中…</div>;
  const displayText = meeting.corrected || meeting.rawText;

  return (
    <div className="pt-10">
      <div className="flex items-center gap-3 mb-8">
        <Link to="/" className="text-apple-blue text-sm">‹ 返回</Link>
        <h1 className="text-3xl font-semibold tracking-tight flex-1">{meeting.title}</h1>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={copyText}>复制</button>
          <button className="btn-secondary" onClick={correctText} disabled={correcting || !meeting.rawText}>
            {correcting ? '纠正中…' : '纠错'}
          </button>
          <button className="btn-primary" onClick={generateSummary} disabled={generating || !meeting.rawText}>
            {generating ? '生成中…' : summary ? '重新生成' : '生成纪要'}
          </button>
        </div>
      </div>

      {error && <div className="card p-4 mb-6 text-red-600 bg-red-50 border-red-100">{error}</div>}

      {summary ? (
        <SummaryView summary={summary} />
      ) : (
        <div className="card p-10 text-center text-gray-400">
          {meeting.rawText
            ? <p>点击「生成纪要」，由 AI 智能梳理会议内容</p>
            : <p>暂无转写内容，请先在会议页录制或上传</p>}
        </div>
      )}

      {/* 全文 */}
      <section className="mt-10">
        <h2 className="text-xl font-semibold mb-4">
          全文转写 {meeting.corrected && <span className="text-xs font-normal text-green-600 ml-2">已纠错</span>}
        </h2>
        <div className="card p-8 whitespace-pre-wrap text-gray-700 leading-loose">
          {displayText || '暂无内容'}
        </div>
      </section>
    </div>
  );
}

function SummaryView({ summary }) {
  return (
    <div className="space-y-6">
      {/* 摘要 */}
      <section className="card p-8">
        <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-3">摘要</h2>
        <p className="text-lg leading-relaxed">{summary.summary}</p>
      </section>

      {/* 参会人 */}
      {summary.participants?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">参会人</h2>
          <div className="flex flex-wrap gap-2">
            {summary.participants.map((p, i) => (
              <span key={i} className="px-3 py-1 rounded-full bg-gray-100 text-sm">{p}</span>
            ))}
          </div>
        </section>
      )}

      {/* 议题 */}
      {summary.topics?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-6">核心议题</h2>
          <div className="space-y-6">
            {summary.topics.map((t, i) => (
              <div key={i}>
                <h3 className="font-semibold text-lg mb-2 flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-apple-blue/10 text-apple-blue text-xs flex items-center justify-center">{i + 1}</span>
                  {t.title}
                </h3>
                <ul className="space-y-1.5 pl-8 list-disc text-gray-600">
                  {t.points?.map((p, j) => <li key={j}>{p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 结论 */}
      {summary.decisions?.length > 0 && (
        <section className="card p-8 border-l-4 border-apple-blue">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">结论与决策</h2>
          <ul className="space-y-2">
            {summary.decisions.map((d, i) => (
              <li key={i} className="flex gap-2 text-gray-700"><span className="text-apple-blue">✓</span>{d}</li>
            ))}
          </ul>
        </section>
      )}

      {/* 待办 */}
      {summary.todos?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">行动项</h2>
          <ul className="space-y-3">
            {summary.todos.map((t, i) => (
              <li key={i} className="flex items-start gap-3">
                <input type="checkbox" className="mt-1.5 w-4 h-4 accent-apple-blue" />
                <div>
                  <p className="text-gray-700">{t.task}</p>
                  <p className="text-xs text-gray-400">
                    {t.owner && <>负责人：{t.owner}</>}
                    {t.due && <> · 截止：{t.due}</>}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 时间线 */}
      {summary.timeline?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-6">时间线</h2>
          <div className="relative pl-6 border-l border-gray-200 space-y-5">
            {summary.timeline.map((t, i) => (
              <div key={i} className="relative">
                <span className="absolute -left-[27px] top-1 w-2.5 h-2.5 rounded-full bg-apple-blue" />
                <p className="text-sm text-gray-400">{t.time || `节点 ${i + 1}`}</p>
                <p className="text-gray-700">{t.event}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 发言人 */}
      {summary.speakers?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">发言人观点</h2>
          <div className="space-y-4">
            {summary.speakers.map((s, i) => (
              <div key={i} className="flex gap-3">
                <span className="w-8 h-8 rounded-full bg-apple-blue/10 text-apple-blue text-sm flex items-center justify-center shrink-0">
                  {s.name?.[0]}
                </span>
                <div>
                  <p className="font-medium text-sm">{s.name}</p>
                  <p className="text-gray-600 text-sm">{s.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function buildMarkdown(meeting, summary) {
  const lines = [`# ${meeting.title}`, ''];
  if (summary?.summary) lines.push(`## 摘要\n\n${summary.summary}`);
  if (summary?.topics?.length) {
    lines.push('## 核心议题', '');
    summary.topics.forEach((t) => {
      lines.push(`### ${t.title}`);
      t.points?.forEach((p) => lines.push(`- ${p}`));
      lines.push('');
    });
  }
  if (summary?.decisions?.length) {
    lines.push('## 结论与决策', '');
    summary.decisions.forEach((d) => lines.push(`- ${d}`));
    lines.push('');
  }
  if (summary?.todos?.length) {
    lines.push('## 行动项', '');
    summary.todos.forEach((t) => lines.push(`- [ ] ${t.task}${t.owner ? `（${t.owner}）` : ''}`));
    lines.push('');
  }
  lines.push('## 全文转写', '', '```', meeting.corrected || meeting.rawText, '```');
  return lines.join('\n');
}