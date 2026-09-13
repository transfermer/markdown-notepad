// GET /s/:token  ->  public read-only share page (no auth).
// Serves a small HTML page that fetches /api/shared/:token and renders client-side.

const SHARE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shared Note</title>
  <link rel="stylesheet" href="/css/style.css">
  <style>
    body { max-width: 860px; margin: 0 auto; padding: 32px 20px; }
    .shared-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px; }
    .shared-wrap h1 { margin-top: 0; }
    .note-actions { display: flex; gap: 8px; justify-content: flex-end; margin-bottom: 16px; }
    #note-body { margin-top: 12px; }
    #note-body h1 { border-bottom: 1px solid var(--border); padding-bottom: .3em; }
    #note-body pre { background: #0b0d12; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; }
    #note-body code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    #note-body :not(pre) > code { background: rgba(79,140,255,.12); padding: 2px 5px; border-radius: 4px; color: #9fbfff; }
    #note-body blockquote { border-left: 3px solid var(--accent); margin-left: 0; padding-left: 14px; color: var(--muted); }
    #note-body a { color: var(--accent); }
    #note-body img { max-width: 100%; border-radius: 6px; }
    #note-body table { border-collapse: collapse; }
    #note-body th, #note-body td { border: 1px solid var(--border); padding: 6px 10px; }
  </style>
</head>
<body>
  <div class="shared-wrap">
    <div class="note-actions">
      <button id="btn-dl" class="btn small">⬇ Save to local</button>
    </div>
    <h1 id="note-title">Shared note</h1>
    <div class="muted small" id="note-meta"></div>
    <div id="note-body"><p class="muted">Loading…</p></div>
  </div>
  <script src="/vendor/markdown-it.min.js"><\/script>
  <script>
    (function () {
      var md = window.markdownit({ html: true, linkify: true, breaks: true });
      var token = location.pathname.split('/').filter(Boolean).pop();
      fetch('/api/shared/' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) throw new Error((res.error && res.error.message) || 'Not found');
          var d = res.data;
          document.getElementById('note-title').textContent = d.title || 'Untitled';
          var meta = 'Updated ' + new Date(d.updatedAt).toLocaleString();
          document.getElementById('note-meta').textContent = meta;
          document.getElementById('note-body').innerHTML = md.render(d.content || '');
          document.getElementById('btn-dl').addEventListener('click', function () {
            var blob = new Blob([d.content || ''], { type: 'text/markdown;charset=utf-8' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = (d.title || 'note').replace(/[\\\\/:*?"<>|]/g, '_') + '.md';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
          });
        })
        .catch(function (err) {
          document.getElementById('note-title').textContent = 'Not found';
          document.getElementById('note-body').innerHTML = '<p class="muted">' + err.message + '</p>';
        });
    })();
  </script>
</body>
</html>`;

export async function onRequest(context) {
  return new Response(SHARE_PAGE, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
  });
}