import { taskManager } from './queue.js';
import { runAlignment } from './alignment.js';
import { runDiarization } from './diarization.js';

/** Queue an ordered, failure-isolated local post-processing chain. */
export function enqueuePostProcessing(meetingId, settings, dependencies = {}) {
  if (!settings.postProcessing?.autoAlign && !settings.postProcessing?.autoDiarize) return null;
  const align = dependencies.runAlignment || runAlignment; const diarize = dependencies.runDiarization || runDiarization;
  const manager = dependencies.taskManager || taskManager;
  return manager.create({ type: 'post_processing', lane: 'local', metadata: { meetingId }, run: async (context) => {
    const steps = {};
    if (settings.postProcessing.autoAlign) {
      try { steps.alignment = { status: 'completed', result: await align(meetingId,
        { ...settings.alignment, source: 'auto' }, context) }; }
      catch (error) { steps.alignment = { status: 'failed', error: { code: error.code || 'ALIGNMENT_FAILED', message: error.message } }; }
    }
    if (settings.postProcessing.autoDiarize && !context.isCancellationRequested()) {
      try { steps.diarization = { status: 'completed', result: await diarize(meetingId, settings.diarization, context) }; }
      catch (error) { steps.diarization = { status: 'failed', error: { code: error.code || 'DIARIZATION_FAILED', message: error.message } }; }
    }
    return { meetingId, steps };
  }});
}
