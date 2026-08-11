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
  const [saved, setSaved] = useState(false);

  useEffect(() => { loadSettings().then(() => setForm(useStore.getState().settings)); }, []);
  useEffect(() => { setForm(settings); }, [settings]);

  if (!form) return <div className="pt-24 text-center text-gray-400">加载中…</div>;

  const set = (section, key, value) => {
    setForm((f) => ({ ...f, [section]: { ...f[section], [key]: value } }));
  };

  const onSave = async () => {
    await saveSettings(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const testLLM = async () => {
    setTestMsg('测试中…');
    try {
      await api('/settings/llm/test', { method: 'POST', body: form });
      setTestMsg('✅ 连接成功');
    } catch (e) { setTestMsg('❌ ' + e.message); }
  };

  return (
    <div className="pt-12 max-w-2xl mx-auto">
      <h1 className="text-3xl font-semibold tracking-tight mb-8">设置</h1>

      {/* LLM */}
      <section className="card p-6 mb-6">
        <h2 className="font-semibold mb-4">语言模型 LLM</h2>
        <p className="text-sm text-gray-400 mb-4">统一使用 OpenAI 兼容接口，可填入任意云端或本地模型</p>
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
            <span className="text-sm text-gray-500">{testMsg}</span>
          </div>
        </div>
      </section>

      {/* ASR 云端 */}
      <section className="card p-6 mb-6">
        <h2 className="font-semibold mb-4">语音识别 ASR</h2>
        <Field label="识别引擎">
          <div className="flex flex-wrap gap-2">
            {asrProviders.map((p) => (
              <button
                key={p.id}
                onClick={() => set('asr', 'provider', p.id)}
                className={`px-4 py-2 rounded-full text-sm border transition-colors ${
                  form.asr.provider === p.id ? 'bg-apple-blue text-white border-apple-blue' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
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
          </div>
        )}
        {form.asr.provider === 'mimo' && (
          <div className="space-y-4 mt-4">
            <Field label="MiMo API Key"><input className="input" type="password" value={form.asr.mimo.apiKey} onChange={(e) => set('asr', 'mimo', { ...form.asr.mimo, apiKey: e.target.value })} /></Field>
            <Field label="模型"><input className="input" value={form.asr.mimo.model} onChange={(e) => set('asr', 'mimo', { ...form.asr.mimo, model: e.target.value })} /></Field>
          </div>
        )}
        {form.asr.provider === 'local' && (
          <p className="text-sm text-gray-400 mt-4">本地模型请前往「模型」页管理 whisper 与 Qwen3-ASR。</p>
        )}
      </section>

      {/* 纠错开关 */}
      <section className="card p-6 mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">错别字纠正</h2>
          <p className="text-sm text-gray-400">转写后自动纠正同音字与口语冗余</p>
        </div>
        <Toggle checked={form.correction.enabled} onChange={(v) => set('correction', 'enabled', v)} />
      </section>

      {/* 主题 */}
      <section className="card p-6 mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">外观</h2>
          <p className="text-sm text-gray-400">切换明暗主题</p>
        </div>
        <Toggle checked={form.ui.theme === 'dark'} onChange={(v) => set('ui', 'theme', v ? 'dark' : 'light')} />
      </section>

      <button className="btn-primary w-full" onClick={onSave}>
        {saved ? '✓ 已保存' : '保存设置'}
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
      className={`w-12 h-7 rounded-full transition-colors relative ${checked ? 'bg-apple-blue' : 'bg-gray-300'}`}
    >
      <span className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
    </button>
  );
}