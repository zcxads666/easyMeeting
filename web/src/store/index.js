import { create } from 'zustand';
import { api } from '../api';

export const useStore = create((set, get) => ({
  meetings: [],
  settings: null,
  loading: false,

  async loadMeetings() {
    set({ loading: true });
    try {
      const meetings = await api('/meetings');
      set({ meetings });
    } finally { set({ loading: false }); }
  },

  async loadSettings() {
    const settings = await api('/settings');
    set({ settings });
  },

  async saveSettings(patch) {
    const settings = await api('/settings', { method: 'PATCH', body: patch });
    set({ settings });
    return settings;
  },

  async createMeeting(title) {
    const m = await api('/meetings', { method: 'POST', body: { title } });
    set({ meetings: [m, ...get().meetings] });
    return m;
  },

  updateMeetingLocal(id, patch) {
    set({ meetings: get().meetings.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  },

  async deleteMeeting(id) {
    await api(`/meetings/${id}`, { method: 'DELETE' });
    set({ meetings: get().meetings.filter((m) => m.id !== id) });
  }
}));