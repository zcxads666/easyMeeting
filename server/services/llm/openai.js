import OpenAI from 'openai';

export function createClient(settings) {
  const { baseUrl, apiKey, model } = settings.llm;
  if (!baseUrl || !apiKey || !model) {
    throw new Error('未配置 LLM（baseUrl / apiKey / model）');
  }
  return {
    client: new OpenAI({ baseURL: baseUrl, apiKey }),
    model
  };
}

// 非流式
export async function chat(settings, messages, { temperature } = {}) {
  const { client, model } = createClient(settings);
  const res = await client.chat.completions.create({
    model,
    messages,
    temperature: temperature ?? settings.llm.temperature ?? 0.3
  });
  return res.choices?.[0]?.message?.content || '';
}

// 流式：返回 async generator
export async function* chatStream(settings, messages, { temperature } = {}) {
  const { client, model } = createClient(settings);
  const stream = await client.chat.completions.create({
    model,
    messages,
    temperature: temperature ?? settings.llm.temperature ?? 0.3,
    stream: true
  });
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// 测试模型可达性
export async function test(settings) {
  const { client, model } = createClient(settings);
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 5
  });
  return res.choices?.[0]?.message?.content !== undefined;
}