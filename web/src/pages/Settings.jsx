import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';

const asrProviders = [
  { id: 'qwen', label: '千问 Qwen' },
  { id: 'volc', label: '火山引擎' },
  { id: 'mimo', label: 'MiMo(小米)' },
  { id: 'local', label: '本地模型' }
];

export default function Settings() {
  const { settings, loadSettings, saveSettings } = useStore();
  const [form, setForm] = useState(null);
  const [testMsg, setTestMsg] = useState('');
  const [asrTestMsg, setAsrTestMsg] = useState('');
  const [savedSection, setSavedSection] = useState('');
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticMsg, setDiagnosticMsg] = useState('');

  useEffect(() => { loadSettings().then(() => setForm(useStore.getState().settings)); }, []);
  useEffect(() => { setForm(settings); }, [settings]);

  if (!form) return <div className="pt-24 text-center text-gray-400">加载中…</div>;

  const set = (section, key, value) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], [key]: value } }));
  };

  const saveSection = async (section) => {
    await saveSettings({ [section]: form[section] });
    setSavedSection(section);
    setTimeout(() => setSavedSection(''), 1500);
  };

  const saveAll = async () => {
    await saveSettings(form);
    setSavedSection('all');
    setTimeout(() => setSavedSection(''), 1500);
  };

  const testLLM = async () => {
    setTestMsg('测试中…');
    try {
      const r = await api('/settings/llm/test', { method: 'POST', body: form });
      setTestMsg('✅ ' + (r.message || '连接成功'));
    } catch (e) { setTestMsg('❌ ' + e.message); }
  };

  const testASR = async () => {
    setAsrTestMsg('测试中…');
    try {
      const r = await api('/settings/asr/test', { method: 'POST', body: form });
      setAsrTestMsg('✅ ' + (r.message || '连接成功'));
    } catch (e) { setAsrTestMsg('❌ ' + e.message); }
  };

  const refreshDiagnostics = async () => {
    setDiagnosticMsg('读取中…');
    try { setDiagnostics(await api('/diagnostics')); setDiagnosticMsg(''); }
    catch (e) { setDiagnosticMsg('读取失败：' + e.message); }
  };
  const copyDiagnostics = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2)); setDiagnosticMsg('✓ 已复制'); }
    catch (e) { setDiagnosticMsg('复制失败：' + e.message); }
  };
  const exportDiagnostics = async () => {
    try {
      const bundle = await api('/diagnostics/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `easyMeeting-diagnostics-${Date.now()}.json`; anchor.click();
      URL.revokeObjectURL(url); setDiagnosticMsg('✓ 已导出');
    } catch (e) { setDiagnosticMsg('导出失败：' + e.message); }
  };

  return (
    <div className="pt-12 max-w-2xl mx-auto">
      <h1 className="text-3xl font-semibold tracking-tight mb-8">设置</h1>

      {/* LLM */}
      <section className="card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">语言模型 LLM</h2>
          {savedSection === 'llm' && <span className="text-xs text-green-600">✓ 已保存</span>}
        </div>
        <p className="text-sm text-gray-400 dark:text-gray-500 mb-4">统一使用 OpenAI 兼容接口，可填入任意云端或本地模型</p>
        <div className="space-y-4">
          <Field label="Base URL" hint="如 https://api.openai.com/v1">
            <input className="input" value={form.llm.baseUrl} onChange={(e) => set('llm', 'baseUrl', e.target.value)} placeholder="https://…/v1" />
          </Field>
          <Field label="API Key">
            <input className="input" type="password" value={form.llm.apiKey} onChange={(e) => set('llm', 'apiKey', e.target.value)} placeholder="sk-…" />
          </Field>
          <Field label="模型名称">
            <input className="input" value={form.llm.model} onChange={(e) => set('llm', 'model', e.target.value)} placeholder="gpt-4o / qwen-plus / 本地模型名" />
          </Field>
          <Field label="温度">
            <input className="input" type="number" step="0.1" min="0" max="1" value={form.llm.temperature} onChange={(e) => set('llm', 'temperature', parseFloat(e.target.value))} />
          </Field>
          <div className="flex items-center gap-3">
            <button className="btn-secondary" onClick={testLLM}>测试连接</button>
            <button className="btn-primary" onClick={() => saveSection('llm')}>保存 LLM</button>
            <span className="text-sm text-gray-500 dark:text-gray-400">{testMsg}</span>
          </div>
        </div>
      </section>

      <section className="card p-6 mb-6">
        <h2 className="font-semibold mb-2">高级本地处理</h2>
        <p className="text-sm text-gray-400 mb-4">说话人分离是可选离线功能；Community-1 下载前需接受 Hugging Face 条款。</p>
        <div className="space-y-4">
          <Field label="Hugging Face Token"><input className="input" type="password" value={form.huggingFace.token} onChange={(e) => set('huggingFace', 'token', e.target.value)} placeholder="hf_…" /></Field>
          <div className="flex items-center justify-between"><span className="text-sm">转写后自动精确对齐</span><Toggle checked={form.postProcessing.autoAlign} onChange={(value) => set('postProcessing', 'autoAlign', value)} /></div>
          <div className="flex items-center justify-between"><span className="text-sm">转写后自动说话人分离</span><Toggle checked={form.postProcessing.autoDiarize} onChange={(value) => set('postProcessing', 'autoDiarize', value)} /></div>
          <button className="btn-primary" onClick={() => saveAll()}>保存高级设置</button>
        </div>
      </section>

      {/* ASR 云端 */}
      <section className="card p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">语音识别 ASR</h2>
          {savedSection === 'asr' && <span className="text-xs text-green-600">✓ 已保存</span>}
        </div>
        <Field label="识别引擎">
          <div className="flex flex-wrap gap-2">
            {asrProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => set('asr', 'provider', p.id)}
                className={`px-4 py-2 rounded-full text-sm border transition-colors ${
                  form.asr.provider === p.id ? 'bg-apple-blue text-white border-apple-blue' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 dark:bg-[#2c2c2e] dark:border-white/10 dark:text-gray-300 dark:hover:bg-[#3a3a3c]'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        {form.asr.provider === 'qwen' && (
          <div className="space-y-4 mt-4">
            <Field label="千问 API Key"><input className="input" type="password" value={form.asr.qwen.apiKey} onChange={(e) => set('asr', 'qwen', { ...form.asr.qwen, apiKey: e.target.value })} /></Field>
            <Field label="模型"><input className="input" value={form.asr.qwen.model} onChange={(e) => set('asr', 'qwen', { ...form.asr.qwen, model: e.target.value })} /></Field>
          </div>
        )}
        {form.asr.provider === 'volc' && (
          <div className="space-y-4 mt-4">
            <Field label="App ID"><input className="input" value={form.asr.volc.appid} onChange={(e) => set('asr', 'volc', { ...form.asr.volc, appid: e.target.value })} /></Field>
            <Field label="Access Token"><input className="input" type="password" value={form.asr.volc.token} onChange={(e) => set('asr', 'volc', { ...form.asr.volc, token: e.target.value })} /></Field>
            <Field label="Cluster" hint="默认 volcengine_input_common"><input className="input" value={form.asr.volc.cluster} onChange={(e) => set('asr', 'volc', { ...form.asr.volc, cluster: e.target.value })} /></Field>
          </div>
        )}
        {form.asr.provider === 'mimo' && (
          <div className="space-y-4 mt-4">
            <Field label="MiMo API Key"><input className="input" type="password" value={form.asr.mimo.apiKey} onChange={(e) => set('asr', 'mimo', { ...form.asr.mimo, apiKey: e.target.value })} /></Field>
            <Field label="模型"><input className="input" value={form.asr.mimo.model} onChange={(e) => set('asr', 'mimo', { ...form.asr.mimo, model: e.target.value })} /></Field>
          </div>
        )}
        {form.asr.provider === 'local' && (
          <p className="text-sm text-gray-400 dark:text-gray-500 mt-4">本地模型请前往「模型」页管理 whisper 与 Qwen3-ASR。</p>
        )}

        <div className="flex items-center gap-3 mt-5">
          <button className="btn-secondary" onClick={testASR}>测试 ASR</button>
          <button className="btn-primary" onClick={() => saveSection('asr')}>保存 ASR</button>
          <span className="text-sm text-gray-500 dark:text-gray-400">{asrTestMsg}</span>
        </div>
      </section>

      {/* 主题 */}
      <section className="card p-6 mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">外观</h2>
          <p className="text-sm text-gray-400 dark:text-gray-500">切换明暗主题</p>
        </div>
        <Toggle checked={form.ui.theme === 'dark'} onChange={(v) => set('ui', 'theme', v ? 'dark' : 'light')} />
      </section>

      <section className="card p-6 mb-6">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="font-semibold">诊断</h2><p className="text-sm text-gray-400">仅包含脱敏后的应用、运行环境和设备状态</p></div>
          <div className="flex gap-2"><button className="btn-secondary" onClick={refreshDiagnostics}>刷新</button>
            <button className="btn-secondary" disabled={!diagnostics} onClick={copyDiagnostics}>复制诊断信息</button>
            <button className="btn-secondary" onClick={exportDiagnostics}>导出诊断包</button></div>
        </div>
        {diagnosticMsg && <p className="text-sm mt-3 text-gray-500">{diagnosticMsg}</p>}
        {diagnostics && <pre className="mt-4 p-3 rounded-lg bg-gray-100 dark:bg-black/20 text-xs overflow-auto max-h-72">{JSON.stringify(diagnostics, null, 2)}</pre>}
      </section>

      <button className="btn-primary w-full" onClick={saveAll}>
        {savedSection === 'all' ? '✓ 已保存' : '保存全部设置'}
      </button>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="label">{label} {hint && <span className="text-gray-400 font-normal">{hint}</span>}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`w-12 h-7 rounded-full transition-colors relative ${checked ? 'bg-apple-blue' : 'bg-gray-300 dark:bg-white/20'}`}
    >
      <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
    </button>
  );
}
