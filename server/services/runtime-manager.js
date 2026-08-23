import * as python from './python.js';

export class RuntimeManager {
  constructor(adapter = python) { this.adapter = adapter; this.installPromise = null; this.status = 'checking'; this.error = null; }
  async inspect() { const state = await this.adapter.inspectRuntime(); this.status = state.status; this.error = state.error || null; return state; }
  async install({ signal, onStage } = {}) {
    if (this.installPromise) return this.installPromise;
    this.status = this.status === 'broken' ? 'repairing' : 'installing'; this.error = null;
    this.installPromise = this.adapter.installRuntime({ signal, onStage }).then(async () => {
      let state = await this.adapter.inspectRuntime();
      if (!['ready', 'running'].includes(state.status)) throw Object.assign(new Error('Runtime verification failed'), { code: 'RUNTIME_VERIFY_FAILED' });
      if (state.status !== 'running') {
        onStage?.('starting');
        if (!(await this.adapter.spawnPython())) throw Object.assign(new Error('Runtime daemon health check failed'), { code: 'RUNTIME_DAEMON_FAILED' });
        state = await this.adapter.inspectRuntime();
      }
      if (state.status !== 'running') throw Object.assign(new Error('Runtime daemon health check failed'), { code: 'RUNTIME_DAEMON_FAILED' });
      this.status = state.status; return state;
    }).catch((error) => { this.status = error.name === 'AbortError' ? 'broken' : 'error'; this.error = { code: error.code || 'RUNTIME_INSTALL_FAILED', message: error.message }; throw error; })
      .finally(() => { this.installPromise = null; });
    return this.installPromise;
  }
  repair(options) { return this.install(options); }
  async start() { this.status = 'starting'; const ok = await this.adapter.spawnPython(); this.status = ok ? 'running' : 'error'; return this.inspect(); }
  async restart() { this.status = 'starting'; const ok = await this.adapter.restartRuntime(); this.status = ok ? 'running' : 'error'; return this.inspect(); }
}

export const runtimeManager = new RuntimeManager();
