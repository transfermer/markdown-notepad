// GET /api/health  ->  service status + optional WebDAV config
import { ok, getEnv } from './_lib.js';

export async function onRequest(context) {
  const env = getEnv(context.env);
  return ok({
    service: 'markdown-notepad',
    time: Date.now(),
    webdav: {
      enabled: !!env.WEBDAV_URL
    }
  });
}