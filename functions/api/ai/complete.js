// POST /api/ai/complete  -> run an AI action through the server-side proxy.
//
// Body: { action, input, instruction?, language?, context? }
// The provider API key never leaves the server.
import { ok, fail, unauthorized, methodNotAllowed, handleOptions, getEnv, isAuthed } from '../_lib.js';
import {
  readAiConfig, callChatCompletion, buildMessages, isSafeUpstreamUrl, AI_ACTIONS
} from './_ai.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return handleOptions();
  if (context.request.method !== 'POST') return methodNotAllowed();
  if (!(await isAuthed(context))) return unauthorized();

  let body;
  try {
    body = await context.request.json();
  } catch {
    return fail('Invalid JSON body', 400, 'BAD_REQUEST');
  }

  const action = body.action === 'test'
    ? 'test'
    : (AI_ACTIONS.includes(body.action) ? body.action : 'custom');

  const cfg = await readAiConfig(context.env.DB, getEnv(context.env));
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    return fail(
      'AI provider is not configured. Open Settings to add a base URL, model and API key.',
      400,
      'AI_NOT_CONFIGURED'
    );
  }
  if (!isSafeUpstreamUrl(cfg.baseUrl)) {
    return fail('The configured base URL is not allowed.', 400, 'BAD_BASE_URL');
  }

  const prompt = buildMessages({
    action,
    instruction: body.instruction,
    input: body.input,
    context: body.context,
    language: body.language
  });

  // Optional operator override (AI_TIMEOUT_MS) for the upstream request bound.
  const env = getEnv(context.env);
  const configuredTimeout = Number(env.AI_TIMEOUT_MS);
  const timeoutOverride = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? { timeoutMs: configuredTimeout }
    : {};

  const overrides = action === 'test'
    ? { maxTokens: 8, temperature: 0, ...timeoutOverride }
    : timeoutOverride;

  const MAX_INPUT_CHARS = 12000;
  if (String(body.input == null ? '' : body.input).length > MAX_INPUT_CHARS) {
    return fail(`Input is too long (${MAX_INPUT_CHARS} chars max). Shorten the note or selection.`, 400, 'INPUT_TOO_LONG');
  }

  const result = await callChatCompletion(
    cfg,
    [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user }
    ],
    overrides
  );

  if (!result.ok) {
    if (result.timeout) return fail(result.error, 504, 'UPSTREAM_TIMEOUT');
    return fail(`Provider error: ${result.error}`, 502, 'UPSTREAM_ERROR');
  }
  return ok({ action, text: result.text });
}
