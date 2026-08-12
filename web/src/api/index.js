import { BASE_URL } from '../env';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

export async function uploadMeeting(id, file, onProgress) {
  const form = new FormData();
  form.append('audio', file);
  const res = await fetch(`${BASE_URL}/api/meetings/${id}/transcribe`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '上传失败');
  return data.taskId;
}
