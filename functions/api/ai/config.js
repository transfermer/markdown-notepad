// GET /api/ai/config  -> masked AI config
// PUT /api/ai/config  -> save AI config (API key encrypted at rest, never returned)
import { ok, fail, unauthorized, methodNotAllowed, handleOptions, getEnv, isAuthed } from '../_lib.js';
import {
  readAiConfig, publicAiConfig, saveAiConfig, isSafeUpstreamUrl, clearAiKey
} from './_ai.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return handleOptions();
  if (!(await isAuthed(context))) return unauthorized();

  switch (context.request.method) {
    case 'GET': return handleGet(context);
    case 'PUT': return handlePut(context);
    default: return methodNotAllowed();
  }
}

async function handleGet(context) {
  const cfg = await readAiConfig(context.env.DB, getEnv(context.env));
  return ok(publicAiConfig(cfg));
}

async function handlePut(context) {
  let body;
  try {
    body = await context.request.json();
  } catch {
    return fail('Invalid JSON body', 400, 'BAD_REQUEST');
  }

  const patch = {};

  if (typeof body.baseUrl === 'string') {
    const baseUrl = body.baseUrl.trim();
    if (baseUrl && !isSafeUpstreamUrl(baseUrl)) {
      return fail('Base URL must be a public http(s) endpoint', 400, 'BAD_BASE_URL');
    }
    patch.baseUrl = baseUrl;
  }
  if (typeof body.model === 'string') {
    patch.model = body.model.trim().slice(0, 200);
  }
  if (body.temperature !== undefined && body.temperature !== null && body.temperature !== '') {
    const t = Number(body.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) {
      return fail('temperature must be between 0 and 2', 400, 'BAD_TEMPERATURE');
    }
    patch.temperature = t;
  }
  if (body.maxTokens !== undefined && body.maxTokens !== null && body.maxTokens !== '') {
    const m = Number(body.maxTokens);
    if (!Number.isInteger(m) || m < 1 || m > 4096) {
      return fail('maxTokens must be an integer between 1 and 4096', 400, 'BAD_MAX_TOKENS');
    }
    patch.maxTokens = m;
  }
  if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
    patch.apiKey = body.apiKey.trim();
  }

  try {
    if (body.clearKey === true) await clearAiKey(context.env.DB);
    const cfg = await saveAiConfig(context.env.DB, getEnv(context.env), patch);
    return ok(publicAiConfig(cfg));
  } catch (err) {
    return fail(String((err && err.message) || err), 500, 'CONFIG_SAVE_FAILED');
  }
}
