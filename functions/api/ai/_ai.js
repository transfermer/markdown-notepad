// AI provider helpers: encrypted config storage, SSRF guard, upstream calls,
// and prompt construction. Shared by the /api/ai/* functions.

import { now } from '../_lib.js';

// ---------------------------------------------------------------------------
// base64 / hex helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64encode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bytesToHex(arr);
}

// ---------------------------------------------------------------------------
// Settings storage (D1 key/value)
// ---------------------------------------------------------------------------

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(db, key, value) {
  await db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(value), now()).run();
}

// ---------------------------------------------------------------------------
// Encryption at rest for the provider API key
// ---------------------------------------------------------------------------

export function aiConfigSecret(env) {
  // Dedicated secret preferred; otherwise fall back to another server-only secret.
  return env.AI_CONFIG_SECRET || env.SESSION_SECRET || env.ADMIN_PASSWORD || '';
}

async function deriveKey(secret, saltHex) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptSecret(plaintext, secret, saltHex) {
  const key = await deriveKey(secret, saltHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext));
  return `${b64encode(iv)}.${b64encode(ct)}`;
}

export async function decryptSecret(payload, secret, saltHex) {
  const [ivB64, ctB64] = String(payload).split('.');
  if (!ivB64 || !ctB64) throw new Error('malformed ciphertext');
  const key = await deriveKey(secret, saltHex);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(ivB64) },
    key,
    b64decode(ctB64)
  );
  return decoder.decode(pt);
}

// ---------------------------------------------------------------------------
// SSRF guard for the user-supplied base URL
// ---------------------------------------------------------------------------

export function isSafeUpstreamUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;                 // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;         // private
    if (a === 192 && b === 168) return false;                  // private
    if (a === 100 && b >= 64 && b <= 127) return false;        // CGNAT
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

const defaults = { baseUrl: '', model: '', temperature: null, maxTokens: null };

export async function readAiConfig(db, env) {
  const [baseUrl, model, temperature, maxTokens, keyEnc, salt, preview] = await Promise.all([
    getSetting(db, 'ai.base_url'),
    getSetting(db, 'ai.model'),
    getSetting(db, 'ai.temperature'),
    getSetting(db, 'ai.max_tokens'),
    getSetting(db, 'ai.api_key_enc'),
    getSetting(db, 'ai.key_salt'),
    getSetting(db, 'ai.key_preview')
  ]);

  let apiKey = '';
  const secret = aiConfigSecret(env);
  if (keyEnc && salt && secret) {
    try {
      apiKey = await decryptSecret(keyEnc, secret, salt);
    } catch {
      apiKey = '';
    }
  }

  return {
    baseUrl: baseUrl || defaults.baseUrl,
    model: model || defaults.model,
    temperature: temperature == null ? null : Number(temperature),
    maxTokens: maxTokens == null ? null : Number(maxTokens),
    apiKey,
    hasKey: !!apiKey,
    keyPreview: preview || ''
  };
}

/** Public (masked) view of the config — never exposes the key. */
export function publicAiConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    hasKey: cfg.hasKey,
    keyPreview: cfg.keyPreview
  };
}

function maskKey(key) {
  if (!key) return '';
  const tail = key.slice(-4);
  return `••••${tail}`;
}

export async function saveAiConfig(db, env, patch) {
  if (typeof patch.baseUrl !== 'undefined') await setSetting(db, 'ai.base_url', patch.baseUrl);
  if (typeof patch.model !== 'undefined') await setSetting(db, 'ai.model', patch.model);
  if (typeof patch.temperature !== 'undefined' && patch.temperature !== null) {
    await setSetting(db, 'ai.temperature', patch.temperature);
  }
  if (typeof patch.maxTokens !== 'undefined' && patch.maxTokens !== null) {
    await setSetting(db, 'ai.max_tokens', patch.maxTokens);
  }

  if (typeof patch.apiKey === 'string' && patch.apiKey !== '') {
    const secret = aiConfigSecret(env);
    if (!secret) {
      throw new Error('No server secret available to encrypt the API key');
    }
    let salt = await getSetting(db, 'ai.key_salt');
    if (!salt) {
      salt = randomHex(16);
      await setSetting(db, 'ai.key_salt', salt);
    }
    const cipher = await encryptSecret(patch.apiKey, secret, salt);
    await setSetting(db, 'ai.api_key_enc', cipher);
    await setSetting(db, 'ai.key_preview', maskKey(patch.apiKey));
  }

  return readAiConfig(db, env);
}

export async function clearAiKey(db) {
  await setSetting(db, 'ai.api_key_enc', '');
  await setSetting(db, 'ai.key_preview', '');
}

// ---------------------------------------------------------------------------
// Provider call + prompts
// ---------------------------------------------------------------------------

// Abort an upstream call that takes longer than this, so we can return a clean
// error instead of hanging until the edge/proxy times the request out (524).
export const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Calls an OpenAI-compatible /chat/completions endpoint.
 * Returns { ok: true, text } or { ok: false, status, timeout?, error }.
 * `overrides.timeoutMs` bounds the whole request (connect + full body read).
 */
export async function callChatCompletion(cfg, messages, overrides = {}) {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model: cfg.model,
    messages,
    temperature: overrides.temperature ?? cfg.temperature ?? 0.3,
    max_tokens: overrides.maxTokens ?? cfg.maxTokens ?? 1024,
    stream: false
  };

  const requested = Number(overrides.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const timeoutResult = () => ({
    ok: false,
    status: 504,
    timeout: true,
    error: `The model did not respond within ${Math.max(1, Math.round(timeoutMs / 1000))}s. ` +
      'Try a shorter note, fewer max tokens, or a faster model.'
  });

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (controller.signal.aborted) return timeoutResult();
      return { ok: false, status: 502, error: `Request to provider failed: ${(err && err.message) || err}` };
    }

    let text;
    try {
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) return timeoutResult();
      return { ok: false, status: 502, error: `Reading provider response failed: ${(err && err.message) || err}` };
    }

    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!res.ok) {
      let msg = text.slice(0, 500);
      if (data && data.error) {
        msg = typeof data.error === 'string' ? data.error : (data.error.message || JSON.stringify(data.error));
      }
      return { ok: false, status: res.status, error: msg || `Provider error ${res.status}` };
    }

    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    return { ok: true, text: typeof content === 'string' ? content : '' };
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM_BASE =
  'You are a writing assistant embedded in a markdown notepad. ' +
  'Reply with markdown only, no preamble, no explanations of what you did, ' +
  'and never wrap the entire answer in a code fence unless asked.';

export function buildMessages({ action, instruction, input, context, language }) {
  const src = String(input == null ? '' : input);
  const ctx = context
    ? `Note title: ${context.title || '(untitled)'}\nCategory: ${context.category || '(none)'}\nTags: ${(Array.isArray(context.tags) && context.tags.join(', ')) || '(none)'}`
    : '';

  switch (action) {
    case 'test':
      return {
        system: SYSTEM_BASE,
        user: 'Reply with exactly the word: OK'
      };
    case 'summarize':
      return {
        system: SYSTEM_BASE,
        user: `Summarize the following note as 3-6 concise markdown bullet points.\n\n${src}`
      };
    case 'improve':
      return {
        system: SYSTEM_BASE,
        user: `Improve clarity, grammar and wording of the following markdown note while preserving its meaning and structure. Return the full improved note.\n\n${src}`
      };
    case 'rewrite':
      return {
        system: SYSTEM_BASE,
        user: `Rewrite the following markdown note to be clearer and better organized. Return the full rewritten note.\n\n${src}`
      };
    case 'outline':
      return {
        system: SYSTEM_BASE,
        user: `Reorganize the following note into a clean outline using markdown headings and nested bullet points. Return the full result.\n\n${src}`
      };
    case 'expand':
      return {
        system: SYSTEM_BASE,
        user: `Expand the following note with more detail, examples and clarification while keeping the original intent. Return the full expanded note.\n\n${src}`
      };
    case 'title':
      return {
        system: SYSTEM_BASE,
        user: `Suggest one concise title (max 60 characters) for the following note. Reply with the title only, without quotes.\n\n${ctx}\n\n${src}`
      };
    case 'tags':
      return {
        system: SYSTEM_BASE,
        user:
          'Analyze the following note and reply with ONLY a JSON object of the form ' +
          '{"category":"<one short category>","tags":["tag1","tag2"]} with 3-8 lowercase tags. ' +
          `No other text.\n\n${ctx}\n\n${src}`
      };
    case 'translate':
      return {
        system: SYSTEM_BASE,
        user: `Translate the following markdown note into ${language || 'English'}. Preserve markdown formatting. Return only the translation.\n\n${src}`
      };
    case 'custom':
    default:
      return {
        system: SYSTEM_BASE,
        user: `${instruction || 'Help improve the following note.'}\n\n${src}`
      };
  }
}

export const AI_ACTIONS = [
  'summarize',
  'improve',
  'rewrite',
  'outline',
  'expand',
  'title',
  'tags',
  'translate',
  'custom'
];
