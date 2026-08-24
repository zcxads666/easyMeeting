// 渲染进程安全桥：仅暴露运行所需的最小信息（无 Node 能力透传）
const { contextBridge, ipcRenderer } = require('electron');

function readArg(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('meetingBridge', {
  baseUrl: readArg('--meeting-base-url='),
  apiToken: readArg('--meeting-api-token='),
  version: readArg('--meeting-version='),
  platform: process.platform,
  selectDirectory: (title) => ipcRenderer.invoke('select-directory', { title }),
  restart: () => ipcRenderer.invoke('restart-app')
});
