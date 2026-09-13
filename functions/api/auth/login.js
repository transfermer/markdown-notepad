// POST /api/auth/login  { password }  ->  sets HttpOnly session cookie
import { json, fail, getEnv, validateAdminPassword } from '../_lib.js';

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } }, 405);
  }
  try {
    const body = await context.request.json();
    const password = typeof body.password === 'string' ? body.password : '';
    const env = getEnv(context.env);

    if (!env.ADMIN_PASSWORD) {
      return fail('Login is not configured on the server (ADMIN_PASSWORD is unset)', 503, 'NOT_CONFIGURED');
    }
    if (!validateAdminPassword(password)) {
      return fail('Invalid password', 401, 'UNAUTHORIZED');
    }

    if (!(await timingSafeMatch(password, env.ADMIN_PASSWORD))) {
      return fail('Invalid password', 401, 'UNAUTHORIZED');
    }

    const token = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
    await context.env.CACHE.put('session:' + token, '1', { expirationTtl: 60 * 60 * 24 * 7 }); // 7 days

    return json(
      { ok: true, data: { message: 'Logged in' } },
      200,
      {
        'Set-Cookie': `mdnote_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}; Secure`
      }
    );
  } catch (err) {
    return fail('Invalid request', 400, 'BAD_REQUEST');
  }
}

async function timingSafeMatch(a, b) {
  const enc = new TextEncoder();
  const A = enc.encode(a);
  const B = enc.encode(b);
  let diff = A.length ^ B.length;
  const max = Math.max(A.length, B.length);
  for (let i = 0; i < max; i++) {
    diff |= (A[i] || 0) ^ (B[i] || 0);
  }
  return diff === 0;
}