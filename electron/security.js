import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isSafeExternalUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function isAllowedRendererNavigation(value, { isDev, devUrl, baseUrl, distRoot }) {
  try {
    const url = new URL(value);
    if (url.origin === new URL(baseUrl).origin) return true;
    if (isDev && url.origin === new URL(devUrl).origin) return true;
    if (!isDev && url.protocol === 'file:') {
      const file = path.resolve(fileURLToPath(url));
      const relative = path.relative(path.resolve(distRoot), file);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }
    return false;
  } catch { return false; }
}
