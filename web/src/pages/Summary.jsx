import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { BASE_URL, API_TOKEN } from '../env';

export default function Summary() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [summary, setSummary] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [speakerView, setSpeakerView] = useState(null);
  const [organizingSpeaker, setOrganizingSpeaker] = useState(false);
  const [error, setError] = useState('');
  const streamRef = useRef(null);

  useEffect(() => {
    setMeeting(null);
    setSummary(null);
    setError('');
    api(`/meetings/${id}`).then((m) => {
      setMeeting(m);
      setSummary(m.summary);
    }).catch(() => setError('会议不存在或加载失败'));
  }, [id]);

  const generateSummary = async () => {
    if (!meeting?.rawText) return;
    setGenerating(true);
    setError('');
    setSummary(null);
    setStreamText('');

    try {
      const res = await fetch(`${BASE_URL}/api/llm/summary/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(API_TOKEN ? { 'X-Meeting-Token': API_TOKEN } : {})
        },
        body: JSON.stringify({ text: meeting.corrected || meeting.rawText })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `请求失败 ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        acc += chunk;
        streamRef.current = acc;
        setStreamText(acc);
      }
      // 检查流式错误
      const errMatch = acc.match(/\[ERROR\]\s*(.+)/s);
      if (errMatch) {
        throw new Error(errMatch[1].trim());
      }
      // 尝试解析为 JSON
      let parsed;
      try {
        const cleaned = acc.replace(/```json/g, '').replace(/```/g, '').trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { summary: acc.trim() };
      }
      setSummary(parsed);
      setStreamText('');
      const updated = await api(`/meetings/${id}`, { method: 'PATCH', body: { summary: parsed, status: 'summarized' } });
      setMeeting(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
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

  const startEdit = () => {
    setEditText(meeting.corrected || meeting.rawText || '');
    setEditing(true);
  };

  const saveEdit = async () => {
    setSavingEdit(true);
    try {
      const updated = await api(`/meetings/${id}`, { method: 'PATCH', body: { corrected: editText } });
      setMeeting(updated);
      setEditing(false);
    } catch (e) { setError(e.message); }
    finally { setSavingEdit(false); }
  };

  const organizeSpeakers = async () => {
    setOrganizingSpeaker(true);
    setError('');
    try {
      const { speaker } = await api('/llm/speaker', { method: 'POST', body: { text: meeting.corrected || meeting.rawText } });
      setSpeakerView(speaker);
    } catch (e) { setError(e.message); }
    finally { setOrganizingSpeaker(false); }
  };

  const exportMarkdown = () => {
    const md = buildMarkdown(meeting, summary);
    downloadBlob(md, `${meeting.title || '会议纪要'}.md`, 'text/markdown');
  };

  const exportHtml = () => {
    const html = buildHtml(meeting, summary);
    downloadBlob(html, `${meeting.title || '会议纪要'}.html`, 'text/html');
  };

  const exportPdf = () => {
    const html = buildHtml(meeting, summary);
    const w = window.open('', '_blank');
    if (!w) { setError('请允许弹窗以导出 PDF'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  const copyText = () => {
    navigator.clipboard.writeText(buildMarkdown(meeting, summary));
  };

  if (!meeting && error) {
    return (
      <div className="pt-24 text-center text-gray-400">
        <p>{error}</p>
        <Link to="/" className="text-apple-blue text-sm mt-3 inline-block">返回列表</Link>
      </div>
    );
  }
  if (!meeting) return <div className="pt-24 text-center text-gray-400">加载中…</div>;
  const displayText = meeting.corrected || meeting.rawText;
  const showStream = generating && streamText;

  return (
    <div className="pt-10">
      <div className="flex items-center gap-3 mb-8">
        <Link to="/" className="text-apple-blue text-sm shrink-0">‹ 返回</Link>
        <h1 className="text-3xl font-semibold tracking-tight flex-1 truncate">{meeting.title}</h1>
        <div className="flex gap-2 flex-wrap justify-end">
          <button className="btn-secondary" onClick={copyText}>复制</button>
          <button className="btn-secondary" onClick={exportMarkdown}>MD</button>
          <button className="btn-secondary" onClick={exportHtml}>HTML</button>
          <button className="btn-secondary" onClick={exportPdf}>PDF</button>
          <button className="btn-secondary" onClick={organizeSpeakers} disabled={organizingSpeaker || !meeting.rawText}>
            {organizingSpeaker ? '整理中…' : '说话人整理'}
          </button>
          <button className="btn-secondary" onClick={correctText} disabled={correcting || !meeting.rawText}>
            {correcting ? '纠正中…' : '纠错'}
          </button>
          <button className="btn-primary" onClick={generateSummary} disabled={generating || !meeting.rawText}>
            {generating ? '生成中…' : summary ? '重新生成' : '生成纪要'}
          </button>
        </div>
      </div>

      {error && <div className="card p-4 mb-6 text-red-600 bg-red-50 border-red-100 dark:bg-red-950/30 dark:border-red-900">{error}</div>}

      {showStream ? (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-3">AI 正在整理…</h2>
          <pre className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed whitespace-pre-wrap font-sans cursor-blink">{streamText}</pre>
        </section>
      ) : summary ? (
        <SummaryView summary={summary} />
      ) : (
        <div className="card p-10 text-center text-gray-400">
          {meeting.rawText
            ? <p>点击「生成纪要」，由 AI 智能梳理会议内容</p>
            : <p>暂无转写内容，请先在会议页录制或上传</p>}
        </div>
      )}

      {/* 说话人整理结果 */}
      {speakerView && (
        <section className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">分人发言视图</h2>
            <button className="text-sm text-gray-400 hover:text-apple-blue" onClick={() => setSpeakerView(null)}>收起</button>
          </div>
          <div className="card p-8 whitespace-pre-wrap text-gray-700 dark:text-gray-300 leading-loose">{speakerView}</div>
        </section>
      )}

      {/* 全文 */}
      <section className="mt-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">
            全文转写 {meeting.corrected && <span className="text-xs font-normal text-green-600 ml-2">已纠错</span>}
          </h2>
          {!editing && displayText && (
            <button className="text-sm text-apple-blue hover:underline" onClick={startEdit}>编辑</button>
          )}
        </div>
        {editing ? (
          <div className="card p-4">
            <textarea
              className="input min-h-[300px] font-sans leading-loose resize-y"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <div className="flex gap-2 mt-3 justify-end">
              <button className="btn-secondary" onClick={() => setEditing(false)} disabled={savingEdit}>取消</button>
              <button className="btn-primary" onClick={saveEdit} disabled={savingEdit}>{savingEdit ? '保存中…' : '保存'}</button>
            </div>
          </div>
        ) : (
          <div className="card p-8 whitespace-pre-wrap text-gray-700 dark:text-gray-300 leading-loose">
            {displayText || '暂无内容'}
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryView({ summary }) {
  return (
    <div className="space-y-6">
      {summary.summary && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-3">摘要</h2>
          <p className="text-lg leading-relaxed">{summary.summary}</p>
        </section>
      )}

      {summary.participants?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">参会人</h2>
          <div className="flex flex-wrap gap-2">
            {summary.participants.map((p, i) => (
              <span key={i} className="px-3 py-1 rounded-full bg-gray-100 dark:bg-white/10 text-sm">{p}</span>
            ))}
          </div>
        </section>
      )}

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
                <ul className="space-y-1.5 pl-8 list-disc text-gray-600 dark:text-gray-400">
                  {t.points?.map((p, j) => <li key={j}>{p}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      {summary.decisions?.length > 0 && (
        <section className="card p-8 border-l-4 border-apple-blue">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">结论与决策</h2>
          <ul className="space-y-2">
            {summary.decisions.map((d, i) => (
              <li key={i} className="flex gap-2 text-gray-700 dark:text-gray-300"><span className="text-apple-blue">✓</span>{d}</li>
            ))}
          </ul>
        </section>
      )}

      {summary.todos?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-4">行动项</h2>
          <ul className="space-y-3">
            {summary.todos.map((t, i) => (
              <li key={i} className="flex items-start gap-3">
                <input type="checkbox" className="mt-1.5 w-4 h-4 accent-apple-blue" />
                <div>
                  <p className="text-gray-700 dark:text-gray-300">{t.task}</p>
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

      {summary.timeline?.length > 0 && (
        <section className="card p-8">
          <h2 className="text-sm font-semibold text-apple-blue uppercase tracking-wide mb-6">时间线</h2>
          <div className="relative pl-6 border-l border-gray-200 dark:border-white/20 space-y-5">
            {summary.timeline.map((t, i) => (
              <div key={i} className="relative">
                <span className="absolute -left-[27px] top-1 w-2.5 h-2.5 rounded-full bg-apple-blue" />
                <p className="text-sm text-gray-400">{t.time || `节点 ${i + 1}`}</p>
                <p className="text-gray-700 dark:text-gray-300">{t.event}</p>
              </div>
            ))}
          </div>
        </section>
      )}

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
                  <p className="text-gray-600 dark:text-gray-400 text-sm">{s.summary}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------- 导出辅助 ---------- */

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildMarkdown(meeting, summary) {
  const lines = [`# ${meeting.title}`, ''];
  if (summary?.summary) lines.push(`## 摘要\n\n${summary.summary}`, '');
  if (summary?.participants?.length) {
    lines.push('## 参会人', '', summary.participants.map((p) => `- ${p}`).join('\n'), '');
  }
  if (summary?.topics?.length) {
    lines.push('## 核心议题', '');
    summary.topics.forEach((t) => {
      lines.push(`### ${t.title}`);
      t.points?.forEach((p) => lines.push(`- ${p}`));
      lines.push('');
    });
  }
  if (summary?.decisions?.length) {
    lines.push('## 结论与决策', '', summary.decisions.map((d) => `- ${d}`).join('\n'), '');
  }
  if (summary?.todos?.length) {
    lines.push('## 行动项', '');
    summary.todos.forEach((t) => lines.push(`- [ ] ${t.task}${t.owner ? `（${t.owner}）` : ''}${t.due ? ` · 截止 ${t.due}` : ''}`));
    lines.push('');
  }
  if (summary?.timeline?.length) {
    lines.push('## 时间线', '');
    summary.timeline.forEach((t) => lines.push(`- **${t.time || ''}** ${t.event}`));
    lines.push('');
  }
  if (summary?.speakers?.length) {
    lines.push('## 发言人观点', '');
    summary.speakers.forEach((s) => lines.push(`### ${s.name}`, '', s.summary, ''));
  }
  lines.push('## 全文转写', '', meeting.corrected || meeting.rawText || '');
  return lines.join('\n');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildHtml(meeting, summary) {
  const s = summary || {};
  const css = `
    body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro","PingFang SC",sans-serif;background:#f5f5f7;color:#1d1d1f;margin:0;padding:40px;line-height:1.6}
    .wrap{max-width:720px;margin:0 auto}
    h1{font-size:32px;font-weight:600;margin:0 0 8px;letter-spacing:-.5px}
    h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0071e3;margin:32px 0 12px;font-weight:600}
    .card{background:#fff;border-radius:18px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid rgba(0,0,0,.05)}
    .meta{color:#86868b;font-size:14px;margin-bottom:32px}
    .summary{font-size:18px;line-height:1.6}
    .tag{display:inline-block;background:#f0f0f2;padding:4px 12px;border-radius:980px;font-size:14px;margin:2px}
    ul{padding-left:20px;margin:8px 0}
    li{margin:4px 0;color:#424245}
    .topic{font-weight:600;font-size:18px;margin:16px 0 4px}
    .todo{margin:8px 0}
    .todo small{color:#86868b}
    .timeline{border-left:2px solid #e0e0e0;padding-left:20px}
    .tl-item{margin:12px 0}
    .tl-item .t{color:#86868b;font-size:13px}
    .pre{white-space:pre-wrap;font-family:inherit;background:#f5f5f7;padding:24px;border-radius:18px;margin-top:16px}
    .dec{color:#0071e3;font-weight:bold}
    .sp{display:flex;gap:12px;margin:8px 0;align-items:flex-start}
    .sp .av{width:32px;height:32px;border-radius:50%;background:#0071e31a;color:#0071e3;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
    @media print{body{padding:0;background:#fff}.card{box-shadow:none;border:none;break-inside:avoid}}
  `;
  const parts = [`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meeting.title)}</title><style>${css}</style></head><body><div class="wrap">`];
  parts.push(`<h1>${esc(meeting.title)}</h1>`);
  const date = meeting.createdAt ? new Date(meeting.createdAt).toLocaleString('zh-CN') : '';
  const dur = meeting.duration ? `${Math.round(meeting.duration / 60)} 分钟` : '';
  parts.push(`<p class="meta">${esc(date)}${dur ? ' · ' + esc(dur) : ''}</p>`);

  if (s.summary) parts.push(`<div class="card"><h2>摘要</h2><p class="summary">${esc(s.summary)}</p></div>`);
  if (s.participants?.length) {
    parts.push(`<div class="card"><h2>参会人</h2>${s.participants.map((p) => `<span class="tag">${esc(p)}</span>`).join('')}</div>`);
  }
  if (s.topics?.length) {
    let inner = '';
    s.topics.forEach((t, i) => {
      inner += `<p class="topic">${i + 1}. ${esc(t.title)}</p><ul>${(t.points || []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
    });
    parts.push(`<div class="card"><h2>核心议题</h2>${inner}</div>`);
  }
  if (s.decisions?.length) {
    parts.push(`<div class="card"><h2>结论与决策</h2><ul>${s.decisions.map((d) => `<li><span class="dec">✓</span> ${esc(d)}</li>`).join('')}</ul></div>`);
  }
  if (s.todos?.length) {
    parts.push(`<div class="card"><h2>行动项</h2><ul>${s.todos.map((t) => `<li class="todo">☐ ${esc(t.task)}<small>${t.owner ? ' · 负责人：' + esc(t.owner) : ''}${t.due ? ' · 截止：' + esc(t.due) : ''}</small></li>`).join('')}</ul></div>`);
  }
  if (s.timeline?.length) {
    parts.push(`<div class="card"><h2>时间线</h2><div class="timeline">${s.timeline.map((t) => `<div class="tl-item"><p class="t">${esc(t.time || '')}</p><p>${esc(t.event)}</p></div>`).join('')}</div></div>`);
  }
  if (s.speakers?.length) {
    parts.push(`<div class="card"><h2>发言人观点</h2>${s.speakers.map((sp) => `<div class="sp"><div class="av">${esc(sp.name?.[0] || '?')}</div><div><p style="font-weight:600">${esc(sp.name)}</p><p style="color:#424245">${esc(sp.summary)}</p></div></div>`).join('')}</div>`);
  }
  parts.push(`<div class="card"><h2>全文转写</h2><div class="pre">${esc(meeting.corrected || meeting.rawText || '')}</div></div>`);
  parts.push(`</div></body></html>`);
  return parts.join('\n');
}
