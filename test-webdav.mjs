// Test WebDAV backup against a local mock WebDAV server.
import { createServer } from 'node:http';
import { webdavBackup } from './functions/api/_lib.js';

const received = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.method === 'PUT') {
      res.writeHead(201);
      res.end();
    } else if (req.method === 'MKCOL') {
      res.writeHead(201);
      res.end();
    } else {
      res.writeHead(405);
      res.end();
    }
  });
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/dav`;

const env = {
  WEBDAV_URL: base,
  WEBDAV_USERNAME: 'user',
  WEBDAV_PASSWORD: 'pass'
};

// 1. Normal backup
const note = { id: 'n1', title: 'My Note', content: '# Hello\n\nWorld' };
const r1 = await webdavBackup(env, note);
console.log('backup ok:', r1.ok, '| status:', r1.status);
console.log('sent:', received[0]?.method, received[0]?.url, '| auth:', received[0]?.auth, '| body:', JSON.stringify(received[0]?.body));

// 2. Missing collection -> MKCOL retry path (stateful mock)
let putCount = 0;
const server404 = createServer((req, res) => {
  if (req.method === 'PUT') {
    putCount++;
    if (putCount === 1) { res.writeHead(404); res.end(); return; }  // first PUT: collection missing
    res.writeHead(201); res.end();                                   // retry succeeds
    return;
  }
  if (req.method === 'MKCOL') { res.writeHead(201); res.end(); return; }
  res.writeHead(405); res.end();
});
await new Promise((r) => server404.listen(0, r));
const r2 = await webdavBackup({ ...env, WEBDAV_URL: `http://127.0.0.1:${server404.address().port}/dav` }, note);
console.log('mkcol retry path (should be true):', JSON.stringify(r2));

// 3. Disabled
const r3 = await webdavBackup({ ...env, WEBDAV_URL: '' }, note);
console.log('disabled:', JSON.stringify(r3.skipped));

server.close();
server404.close();