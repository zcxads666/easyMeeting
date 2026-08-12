// 桌面端：Electron preload 注入 window.meetingBridge.baseUrl（http://127.0.0.1:端口）
// 浏览器调试兜底：当前页面 origin（vite dev server 或内嵌 server 直访）
const injected = typeof window !== 'undefined' ? window.meetingBridge?.baseUrl : '';
const fallback = typeof window !== 'undefined' ? window.location.origin : '';
export const BASE_URL = injected || fallback;
