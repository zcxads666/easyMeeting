const SECRET_PATTERN = /(authorization|api[-_ ]?key|token|secret|password|transcript|rawtext|corrected|audio(?:ref|data|binary)?)/i;
function sanitize(value, key = '') {
  if (SECRET_PATTERN.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, name)]));
  return value;
}
export function createLogger(component) {
  const write = (level, message, context) => console[level === 'debug' ? 'debug' : level](`[${component}] ${message}`, context ? sanitize(context) : '');
  return { debug: (m, c) => write('debug', m, c), info: (m, c) => write('info', m, c),
    warn: (m, c) => write('warn', m, c), error: (m, c) => write('error', m, c) };
}
export { sanitize as redactLogContext };
