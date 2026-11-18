// POST /api/mcp -> remote MCP server over Streamable HTTP (JSON-RPC 2.0).
//
// Tools are gated by the token scope:
//   read  -> read-only tools
//   write -> read + write tools
// Auth: Authorization: Bearer <api token created at /api/tokens>.
// Stateless: no Mcp-Session-Id is issued; notifications return 202.
import {
  parseTagsJson, invalidateNoteCache, kvPutJSON, now, randomId,
  normalizeCategory, normalizeTags, getEnv, webdavBackup
} from '../_lib.js';
import { authenticateBearer } from '../tokens/_tokens.js';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'markdown-notepad', version: '1.0.0' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id'
};

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

const TOOLS = [
  {
    name: 'list_notes',
    scope: 'read',
    description: 'List notes, most recently updated first. Returns id, title, category, tags and updatedAt.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX, description: 'Max notes to return (default 50).' }
      }
    }
  },
  {
    name: 'get_note',
    scope: 'read',
    description: 'Fetch a single note by id, including its full markdown content.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id']
    }
  },
  {
    name: 'search_notes',
    scope: 'read',
    description: 'Search notes by text in the title or content. Returns matching note metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT_MAX, description: 'Max results (default 50).' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_categories',
    scope: 'read',
    description: 'List categories and tags with the number of notes in each.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_note',
    scope: 'write',
    description: 'Create a new note. Returns the created note including its id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title.' },
        content: { type: 'string', description: 'Markdown content.' },
        category: { type: 'string', description: 'Optional category.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
      }
    }
  },
  {
    name: 'update_note',
    scope: 'write',
    description: 'Update a note. Omitted fields are left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        title: { type: 'string' },
        content: { type: 'string' },
        category: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['id']
    }
  },
  {
    name: 'append_to_note',
    scope: 'write',
    description: 'Append text to the end of a note (adds a blank line first when needed).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        text: { type: 'string', description: 'Markdown text to append.' }
      },
      required: ['id', 'text']
    }
  },
  {
    name: 'delete_note',
    scope: 'write',
    description: 'Delete a note by id. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id']
    }
  }
];

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function send(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function noteMeta(r) {
  return {
    id: r.id,
    title: r.title || '',
    category: r.category || '',
    tags: parseTagsJson(r.tags),
    updatedAt: r.updated_at
  };
}

function noteFull(r) {
  return {
    id: r.id,
    title: r.title || '',
    category: r.category || '',
    tags: parseTagsJson(r.tags),
    content: r.content || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function serializeNote(note) {
  return {
    id: note.id,
    title: note.title || '',
    category: note.category || '',
    tags: Array.isArray(note.tags) ? note.tags : [],
    content: note.content || '',
    createdAt: note.createdAt,
    updatedAt: note.updatedAt
  };
}

function requireId(args) {
  const id = String(args.id == null ? '' : args.id).trim();
  if (!id) throw new Error('id is required');
  return id;
}

async function loadNote(db, id) {
  const row = await db.prepare(
    'SELECT id, title, category, tags, content, created_at FROM notes WHERE id = ?'
  ).bind(id).first();
  if (!row) throw new Error('Note not found');
  return row;
}

async function persistUpdate(context, id, patch) {
  const { DB, CACHE } = context.env;
  const existing = await loadNote(DB, id);
  const ts = now();
  const title = patch.title === undefined ? existing.title : patch.title;
  const content = patch.content === undefined ? existing.content : patch.content;
  const category = patch.category === undefined ? (existing.category || '') : patch.category;
  const tags = patch.tags === undefined ? parseTagsJson(existing.tags) : patch.tags;

  await DB.prepare(
    'UPDATE notes SET title = ?, content = ?, category = ?, tags = ?, updated_at = ? WHERE id = ?'
  ).bind(title, content, category, JSON.stringify(tags), ts, id).run();

  const shareRow = await DB.prepare('SELECT token FROM shares WHERE note_id = ?').bind(id).first();
  const note = { id, title, content, category, tags, createdAt: existing.created_at, updatedAt: ts };

  await invalidateNoteCache(CACHE, id, { share_token: shareRow ? shareRow.token : null });
  await kvPutJSON(CACHE, `note:${id}`, note, 60);
  return note;
}

function makeNotePatch(args) {
  const patch = {};
  if (typeof args.title === 'string') patch.title = args.title.trim().slice(0, 200);
  if (typeof args.content === 'string') patch.content = args.content;
  if (typeof args.category === 'string') patch.category = normalizeCategory(args.category);
  if (typeof args.tags !== 'undefined') patch.tags = normalizeTags(args.tags);
  return patch;
}

async function runTool(context, name, args) {
  const { DB, CACHE } = context.env;

  switch (name) {
    case 'list_notes': {
      const limit = clampInt(args.limit, 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
      const { results } = await DB.prepare(
        'SELECT id, title, category, tags, updated_at FROM notes ORDER BY updated_at DESC LIMIT ?'
      ).bind(limit).all();
      return results.map(noteMeta);
    }
    case 'get_note': {
      const row = await DB.prepare(
        'SELECT id, title, category, tags, content, created_at, updated_at FROM notes WHERE id = ?'
      ).bind(requireId(args)).first();
      if (!row) throw new Error('Note not found');
      return noteFull(row);
    }
    case 'search_notes': {
      const query = String(args.query == null ? '' : args.query).trim();
      if (!query) throw new Error('query is required');
      const limit = clampInt(args.limit, 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT);
      const like = '%' + query + '%';
      const { results } = await DB.prepare(
        'SELECT id, title, category, tags, updated_at FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT ?'
      ).bind(like, like, limit).all();
      return results.map(noteMeta);
    }
    case 'list_categories': {
      const { results } = await DB.prepare('SELECT category, tags FROM notes').all();
      const categories = new Map();
      const tags = new Map();
      for (const r of results) {
        const name = (r.category || '').trim() || 'Uncategorized';
        categories.set(name, (categories.get(name) || 0) + 1);
        for (const tag of parseTagsJson(r.tags)) tags.set(tag, (tags.get(tag) || 0) + 1);
      }
      const toList = (map) =>
        [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      return { categories: toList(categories), tags: toList(tags) };
    }

    case 'create_note': {
      const title = typeof args.title === 'string' ? args.title.trim().slice(0, 200) : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const category = normalizeCategory(args.category);
      const tags = normalizeTags(args.tags);
      const id = randomId();
      const ts = now();

      await DB.prepare(
        'INSERT INTO notes (id, title, category, tags, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, title || 'Untitled', category, JSON.stringify(tags), content, ts, ts).run();

      await invalidateNoteCache(CACHE, id);
      return { id, title: title || 'Untitled', category, tags, content, createdAt: ts, updatedAt: ts };
    }

    case 'update_note': {
      const id = requireId(args);
      const patch = makeNotePatch(args);
      if (Object.keys(patch).length === 0) throw new Error('nothing to update');
      const note = await persistUpdate(context, id, patch);
      const backup = await safeBackup(context, note);
      return { note: serializeNote(note), backedUp: !!(backup && backup.ok) };
    }

    case 'append_to_note': {
      const id = requireId(args);
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text) throw new Error('text is required');
      const existing = await loadNote(DB, id);
      const base = existing.content || '';
      const separator = base && !base.endsWith('\n') ? '\n\n' : '';
      const note = await persistUpdate(context, id, { content: base + separator + text });
      const backup = await safeBackup(context, note);
      return { note: serializeNote(note), backedUp: !!(backup && backup.ok) };
    }

    case 'delete_note': {
      const id = requireId(args);
      const row = await DB.prepare('SELECT id FROM notes WHERE id = ?').bind(id).first();
      if (!row) throw new Error('Note not found');
      const shareRow = await DB.prepare('SELECT token FROM shares WHERE note_id = ?').bind(id).first();
      await DB.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
      await invalidateNoteCache(CACHE, id, { share_token: shareRow ? shareRow.token : null });
      return { id, deleted: true };
    }

    default:
      throw new Error('Unknown tool');
  }
}

async function safeBackup(context, note) {
  try {
    return await webdavBackup(getEnv(context.env), { title: note.title, content: note.content });
  } catch {
    return { ok: false, error: 'backup_failed' };
  }
}

async function handleToolCall(context, auth, id, params) {
  const name = params && params.name;
  const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
  if (tool.scope === 'write' && auth.scope !== 'write') {
    return rpcError(id, -32003, `This token is read-only; the "${name}" tool requires write scope.`);
  }

  try {
    const result = await runTool(context, name, args);
    return rpcResult(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: false
    });
  } catch (err) {
    return rpcResult(id, {
      content: [{ type: 'text', text: String((err && err.message) || err) }],
      isError: true
    });
  }
}

async function handleMessage(context, auth, msg) {
  if (!msg || typeof msg !== 'object') return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    return isNotification ? null : rpcError(id, -32600, 'Invalid Request');
  }

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      const tools = TOOLS.filter((t) => t.scope === 'read' || auth.scope === 'write')
        .map(({ scope, ...rest }) => rest);
      return rpcResult(id, { tools });
    }
    case 'tools/call':
      return handleToolCall(context, auth, id, params || {});
    default:
      return isNotification ? null : rpcError(id, -32601, 'Method not found');
  }
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method === 'DELETE') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify(rpcError(null, -32000, 'Method not allowed')), {
      status: 405,
      headers: { 'Content-Type': 'application/json', Allow: 'POST, DELETE, OPTIONS', ...CORS }
    });
  }

  const auth = await authenticateBearer(context.env.DB, request);
  if (!auth) {
    return new Response(
      JSON.stringify(rpcError(null, -32001, 'Unauthorized: missing or invalid bearer token')),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer', ...CORS }
      }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return send(rpcError(null, -32700, 'Parse error'), 400);
  }

  const isBatch = Array.isArray(payload);
  const messages = isBatch ? payload : [payload];
  const responses = [];
  for (const msg of messages) {
    const res = await handleMessage(context, auth, msg);
    if (res !== null) responses.push(res);
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: CORS });
  }
  return send(isBatch ? responses : responses[0], 200);
}