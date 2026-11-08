/* Markdown Notepad — front-end app. */
(function () {
  'use strict';

  const md = window.markdownit({
    html: true,
    linkify: true,
    breaks: true
  });

  const IMAGE_URL_RE = /^(https?:\/\/|\/\/|\/|data:image\/).+\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?.*)?$/i;
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;

  function isImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (trimmed.startsWith('data:image/')) return true;
    if (IMAGE_URL_RE.test(trimmed)) return true;
    try {
      const u = new URL(trimmed, window.location.origin);
      return IMAGE_EXT_RE.test(u.pathname);
    } catch {
      return IMAGE_EXT_RE.test(trimmed);
    }
  }

  // ---------------- State ----------------
  const state = {
    notes: [],        // list of { id, title, category, tags, updatedAt }
    currentId: null,
    shareToken: null,
    dirty: false,
    search: '',
    filter: 'all',    // 'all' | 'uncategorized' | 'untagged' | 'category:<name>' | 'tag:<tag>'
    categories: [],   // [{ name, count }]
    tags: [],         // [{ name, count }]
    saveTimer: null
  };

  // ---------------- DOM refs ----------------
  const $ = (sel) => document.querySelector(sel);
  const loginView = $('#login-view');
  const mainView = $('#main-view');
  const loginForm = $('#login-form');
  const loginPassword = $('#login-password');
  const loginError = $('#login-error');
  const btnLogout = $('#btn-logout');
  const btnNew = $('#btn-new');
  const btnExport = $('#btn-export');
  const btnBackup = $('#btn-backup');
  const btnDelete = $('#btn-delete');
  const btnPreview = $('#btn-preview');
  const btnShare = $('#btn-share');
  const searchInput = $('#search');
  const noteList = $('#note-list');
  const noteCount = $('#note-count');
  const emptyState = $('#empty-state');
  const editorView = $('#editor-view');
  const noteTitle = $('#note-title');
  const noteCategory = $('#note-category');
  const noteTags = $('#note-tags');
  const noteContent = $('#note-content');
  const notePreview = $('#note-preview');
  const noteSaved = $('#note-saved');
  const mdToolbar = $('#md-toolbar');
  const categoryList = $('#category-list');
  const tagList = $('#tag-list');
  const countAll = $('#count-all');
  const categorySuggestions = $('#category-suggestions');
  const shareModal = $('#share-modal');
  const shareUrl = $('#share-url');
  const shareStatus = $('#share-status');
  const btnShareCopy = $('#btn-share-copy');
  const btnShareCancel = $('#btn-share-cancel');
  const toolsPane = $('#tools-pane');
  const appLayout = $('#app-layout');
  const btnToolsToggle = $('#btn-tools-toggle');
  const btnBackList = $('#btn-back-list');
  const mobileMq = window.matchMedia('(max-width: 820px)');

  function isMobile() {
    return mobileMq.matches;
  }

  function setToolsCollapsed(collapsed, persist) {
    if (!toolsPane || !btnToolsToggle) return;
    toolsPane.classList.toggle('collapsed', collapsed);
    if (appLayout) appLayout.classList.toggle('tools-collapsed', collapsed);
    btnToolsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (persist && !isMobile()) {
      try { localStorage.setItem('toolsCollapsed', collapsed ? '1' : '0'); } catch {}
    }
  }

  function showMobileList() {
    mainView.classList.remove('mobile-editor');
  }

  function showMobileEditor() {
    if (isMobile()) mainView.classList.add('mobile-editor');
  }

  function desktopToolsCollapsedPref() {
    try { return localStorage.getItem('toolsCollapsed') === '1'; } catch { return false; }
  }

  function syncLayoutMode() {
    if (isMobile()) {
      setToolsCollapsed(true);
      if (!state.currentId || editorView.classList.contains('hidden')) showMobileList();
    } else {
      setToolsCollapsed(desktopToolsCollapsedPref());
      mainView.classList.remove('mobile-editor');
    }
  }

  // ---------------- API helper ----------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      ...options
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data ? data.data : null;
  }

  // ---------------- Auth ----------------
  async function checkAuth() {
    try {
      const data = await api('/api/auth/check');
      return !!data.authenticated;
    } catch {
      return false;
    }
  }

  async function showApp() {
    loginView.classList.add('hidden');
    mainView.classList.remove('hidden');
    syncLayoutMode();
    await Promise.all([refreshIndex(), refreshNotes()]);
  }

  function showLogin(message) {
    mainView.classList.add('hidden');
    loginView.classList.remove('hidden');
    if (message) {
      loginError.textContent = message;
      loginError.classList.remove('hidden');
    } else {
      loginError.classList.add('hidden');
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    const password = loginPassword.value;
    if (!password) return;
    const btn = loginForm.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) });
      loginPassword.value = '';
      btn.disabled = false;
      await showApp();
    } catch (err) {
      btn.disabled = false;
      loginError.textContent = err.message;
      loginError.classList.remove('hidden');
    }
  });

  btnLogout.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    state.currentId = null;
    renderNotes([]);
    showLogin();
  });

  // ---------------- Notes: list / refresh ----------------
  async function refreshNotes() {
    try {
      const notes = await api('/api/notes');
      state.notes = notes || [];
      renderNotes(filterNotes());
      if (!state.currentId && state.notes.length > 0) {
        if (isMobile()) {
          showEmpty();
          showMobileList();
        } else {
          openNote(state.notes[0].id);
        }
      } else if (state.notes.length === 0) {
        showEmpty();
        showMobileList();
      }
    } catch (err) {
      // Could be a stale session.
      showLogin(err.message);
    }
  }

  async function refreshIndex() {
    try {
      const data = await api('/api/index');
      state.categories = data.categories || [];
      state.tags = data.tags || [];
      const total = state.notes ? state.notes.length : 0;
      if (countAll) countAll.textContent = total || '';
      renderIndex();
    } catch {}
  }

  function renderIndex() {
    // Categories
    categoryList.innerHTML = '';
    if (!state.categories.length) {
      categoryList.innerHTML = '<span class="muted small">None yet</span>';
    } else {
      state.categories.forEach((c) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip' + (state.filter === 'category:' + c.name ? ' active' : '');
        btn.textContent = c.name;
        const span = document.createElement('span');
        span.className = 'count';
        span.textContent = c.count;
        btn.appendChild(span);
        btn.addEventListener('click', () => setFilter('category:' + c.name));
        categoryList.appendChild(btn);
      });
    }

    // Tags
    tagList.innerHTML = '';
    if (!state.tags.length) {
      tagList.innerHTML = '<span class="muted small">None yet</span>';
    } else {
      state.tags.forEach((t) => {
        const btn = document.createElement('button');
        btn.className = 'tag-chip' + (state.filter === 'tag:' + t.name ? ' active' : '');
        btn.textContent = '#' + t.name;
        const span = document.createElement('span');
        span.className = 'count';
        span.textContent = t.count;
        btn.appendChild(span);
        btn.addEventListener('click', () => setFilter('tag:' + t.name));
        tagList.appendChild(btn);
      });
    }

    // Category datalist suggestions
    categorySuggestions.innerHTML = '';
    state.categories.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.name;
      categorySuggestions.appendChild(opt);
    });

    // Quick tool active states
    document.querySelectorAll('.quick-tool').forEach((el) => {
      el.classList.toggle('active', el.dataset.filter === state.filter);
    });
  }

  function setFilter(f) {
    state.filter = f;
    renderIndex();
    renderNotes(filterNotes());
    if (isMobile()) setToolsCollapsed(true);
  }

  // Quick tool buttons (aside)
  document.querySelectorAll('.quick-tool').forEach((el) => {
    el.addEventListener('click', () => setFilter(el.dataset.filter));
  });

  function filterNotes() {
    const q = state.search.trim().toLowerCase();
    let list = state.notes;
    if (state.filter === 'uncategorized') {
      list = list.filter((n) => !(n.category || '').trim());
    } else if (state.filter === 'untagged') {
      list = list.filter((n) => !n.tags || !n.tags.length);
    } else if (state.filter.startsWith('category:')) {
      const name = state.filter.slice('category:'.length);
      list = list.filter((n) => (n.category || '') === name);
    } else if (state.filter.startsWith('tag:')) {
      const tag = state.filter.slice('tag:'.length);
      list = list.filter((n) => (n.tags || []).includes(tag));
    }
    if (q) {
      list = list.filter((n) => {
        const title = (n.title || '').toLowerCase();
        const cat = (n.category || '').toLowerCase();
        const tags = (n.tags || []).join(' ').toLowerCase();
        return title.includes(q) || cat.includes(q) || tags.includes(q);
      });
    }
    return list;
  }

  function fmtDate(ms) {
    const d = new Date(ms);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderNotes(notes) {
    noteList.innerHTML = '';
    notes.forEach((n) => {
      const li = document.createElement('li');
      const item = document.createElement('div');
      item.className = 'note-item' + (n.id === state.currentId ? ' active' : '');
      item.dataset.id = n.id;

      const title = document.createElement('div');
      title.className = 'note-title';
      title.textContent = n.title || 'Untitled';
      if (n.category) {
        const pill = document.createElement('span');
        pill.className = 'cat-pill';
        pill.textContent = n.category;
        title.appendChild(pill);
      }

      const date = document.createElement('div');
      date.className = 'note-date';
      date.textContent = fmtDate(n.updatedAt);

      item.appendChild(title);
      item.appendChild(date);

      if (n.tags && n.tags.length) {
        const tags = document.createElement('div');
        tags.className = 'note-tags';
        n.tags.slice(0, 3).forEach((t) => {
          const mini = document.createElement('span');
          mini.className = 'mini-tag';
          mini.textContent = '#' + t;
          tags.appendChild(mini);
        });
        item.appendChild(tags);
      }

      li.appendChild(item);
      li.addEventListener('click', () => openNote(n.id));
      noteList.appendChild(li);
    });
    noteCount.textContent = notes.length ? `${notes.length} note${notes.length > 1 ? 's' : ''}` : '';
  }

  function showEmpty() {
    emptyState.classList.remove('hidden');
    editorView.classList.add('hidden');
    showMobileList();
  }

  // ---------------- Notes: open / create / save ----------------
  async function openNote(id) {
    // Save pending edits in the previous note first.
    await flushSave();
    state.currentId = id;
    renderNotes(filterNotes());
    emptyState.classList.add('hidden');
    editorView.classList.remove('hidden');
    showMobileEditor();
    loadNoteIntoUi(id);
  }

  async function loadNoteIntoUi(id) {
    try {
      const note = await api('/api/notes/' + encodeURIComponent(id));
      state.shareToken = null;
      noteTitle.value = note.title || '';
      noteCategory.value = note.category || '';
      noteTags.value = (note.tags || []).join(', ');
      noteContent.value = note.content || '';
      renderPreview();
      noteSaved.textContent = 'Saved';
      state.dirty = false;
    } catch (err) {
      showLogin(err.message);
    }
  }

  function currentNote() {
    return state.notes.find((n) => n.id === state.currentId) || null;
  }

  function promoteImageLinks(root) {
    if (!root) return;
    root.querySelectorAll('a').forEach((a) => {
      if (a.querySelector('img')) return;
      const href = a.getAttribute('href') || '';
      if (!isImageUrl(href)) return;
      const text = (a.textContent || '').trim();
      const looksLikeBareUrl = !text || text === href || text === 'alt' || text === 'image' || text === 'img' || text === 'text';
      if (!looksLikeBareUrl) return;
      const img = document.createElement('img');
      img.src = href;
      img.alt = looksLikeBareUrl && text && text !== href ? text : '';
      a.replaceWith(img);
    });
  }

  function renderPreview() {
    notePreview.innerHTML = md.render(noteContent.value || '');
    promoteImageLinks(notePreview);
  }

  function isPreviewMode() {
    return !notePreview.classList.contains('hidden');
  }

  function setPreviewMode(on) {
    if (on) {
      renderPreview();
      notePreview.classList.remove('hidden');
      noteContent.classList.add('hidden');
      if (mdToolbar) mdToolbar.classList.add('hidden');
      btnPreview.textContent = 'Edit';
      btnPreview.title = 'Back to editor';
    } else {
      notePreview.classList.add('hidden');
      noteContent.classList.remove('hidden');
      if (mdToolbar) mdToolbar.classList.remove('hidden');
      btnPreview.textContent = 'Preview';
      btnPreview.title = 'Toggle preview';
      noteContent.focus();
    }
  }

  btnNew.addEventListener('click', async () => {
    try {
      const note = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled', content: '# New note\n\nStart writing...' })
      });
      state.notes.unshift(note);
      await openNote(note.id);
      await refreshIndex();
    } catch (err) {
      alert(err.message);
    }
  });

  let contentTimer = null;
  function markDirty() {
    state.dirty = true;
    noteSaved.textContent = 'Unsaved...';
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => scheduleSave(), 800);
  }
  noteContent.addEventListener('input', () => {
    markDirty();
    renderPreview();
  });
  noteTitle.addEventListener('input', markDirty);
  noteCategory.addEventListener('input', markDirty);
  noteTags.addEventListener('input', markDirty);

  function scheduleSave() {
    if (!state.currentId) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(async () => {
      try {
        await saveCurrent();
      } catch (err) {
        noteSaved.textContent = 'Save failed';
      }
    }, 700);
  }

  async function saveCurrent() {
    if (!state.currentId || !state.dirty) return;
    const id = state.currentId;
    const title = noteTitle.value.trim() || 'Untitled';
    const content = noteContent.value;
    const category = noteCategory.value.trim();
    const tags = noteTags.value.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const data = await api('/api/notes/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ title, content, category, tags })
      });
      state.dirty = false;
      noteSaved.textContent = 'Saved';
      // Update the list row.
      const n = state.notes.find((x) => x.id === id);
      if (n) { n.title = title; n.category = category; n.tags = tags; n.updatedAt = data.note.updatedAt; }
      renderNotes(filterNotes());
      refreshIndex();
      // backup result (WebDAV)
      const backup = data.backup;
      if (backup && !backup.skipped) {
        noteSaved.textContent = 'Saved' + (backup.ok ? ' · backed up' : ' · backup failed');
      }
    } catch (err) {
      noteSaved.textContent = 'Save failed';
      throw err;
    }
  }

  async function flushSave() {
    if (state.dirty && state.currentId) {
      clearTimeout(state.saveTimer);
      try { await saveCurrent(); } catch {}
    }
  }

  // ---------------- Markdown toolbar ----------------
  // Each insert fn receives (before, selected, after) and returns { value, pos, posEnd? }.

  function applyToTextarea(ta, fn) {
    if (!ta || typeof fn !== 'function') return;
    const start = ta.selectionStart || 0;
    const end = ta.selectionEnd || 0;
    const before = ta.value.slice(0, start);
    const selected = ta.value.slice(start, end);
    const after = ta.value.slice(end);
    let result = fn(before, selected, after);
    if (typeof result === 'function') result = result(before, selected, after);
    if (!result || typeof result.value !== 'string') return;
    ta.value = result.value;
    const pos = Number.isFinite(result.pos) ? result.pos : result.value.length;
    const posEnd = Number.isFinite(result.posEnd) ? result.posEnd : pos;
    try { ta.setSelectionRange(pos, posEnd); } catch {}
  }

  function expandToCurrentLine(before, selected, after) {
    if (selected) return { before, selected, after };
    const lineStart = before.lastIndexOf('\n') + 1;
    const nl = after.indexOf('\n');
    const lineAfter = nl === -1 ? after : after.slice(0, nl);
    return {
      before: before.slice(0, lineStart),
      selected: before.slice(lineStart) + lineAfter,
      after: nl === -1 ? '' : after.slice(nl)
    };
  }

  function wrap(pre, post, placeholder) {
    return (before, selected, after) => {
      const content = selected || placeholder || '';
      const innerStart = before.length + pre.length;
      const value = before + pre + content + post + after;
      if (selected) {
        return { value, pos: innerStart + content.length + post.length };
      }
      return { value, pos: innerStart, posEnd: innerStart + content.length };
    };
  }

  function wrapLine(pre, post, level) {
    return (before, selected, after) => {
      const expanded = expandToCurrentLine(before, selected, after);
      const headingRe = /^(#{1,6})\s+/;
      const content = expanded.selected || ('Heading ' + level);
      const lines = content.split('\n').map((l) => {
        const existing = (l.match(headingRe) || [])[1];
        const stripped = l.replace(headingRe, '');
        if (existing && existing.length === level) return stripped;
        return pre + stripped + (post || '');
      }).join('\n');
      const value = expanded.before + lines + expanded.after;
      return {
        value,
        pos: expanded.before.length,
        posEnd: expanded.before.length + lines.length
      };
    };
  }

  function linePrefix(prefix, placeholder) {
    return (before, selected, after) => {
      const expanded = expandToCurrentLine(before, selected, after);
      const content = expanded.selected || placeholder || '';
      const lines = content.split('\n').map((l) => {
        if (l.startsWith(prefix)) return l;
        return prefix + l;
      }).join('\n');
      const value = expanded.before + lines + expanded.after;
      return {
        value,
        pos: expanded.before.length,
        posEnd: expanded.before.length + lines.length
      };
    };
  }

  function numberedList() {
    return (before, selected, after) => {
      const expanded = expandToCurrentLine(before, selected, after);
      const content = expanded.selected || 'item';
      const lines = content.split('\n').map((l, i) => {
        if (/^\d+\.\s/.test(l)) return l;
        return (i + 1) + '. ' + l.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
      }).join('\n');
      const value = expanded.before + lines + expanded.after;
      return {
        value,
        pos: expanded.before.length,
        posEnd: expanded.before.length + lines.length
      };
    };
  }

  function codeBlock() {
    return (before, selected, after) => {
      const content = selected || 'code here';
      const block = '```js\n' + content + '\n```';
      const value = before + block + after;
      if (selected) {
        return { value, pos: before.length + block.length };
      }
      const inner = before.length + '```js\n'.length;
      return { value, pos: inner, posEnd: inner + content.length };
    };
  }

  function insertImage() {
    return (before, selected, after) => {
      const sel = (selected || '').trim();
      if (sel && isImageUrl(sel)) {
        const snippet = '![](' + sel + ')';
        return { value: before + snippet + after, pos: before.length + snippet.length };
      }
      if (sel) {
        const snippet = '![' + sel + '](https://)';
        const urlStart = before.length + 2 + sel.length + 2;
        return {
          value: before + snippet + after,
          pos: urlStart,
          posEnd: urlStart + 'https://'.length
        };
      }
      const snippet = '![](https://)';
      const urlStart = before.length + 4;
      return {
        value: before + snippet + after,
        pos: urlStart,
        posEnd: urlStart + 'https://'.length
      };
    };
  }

  function table() {
    return (before, selected, after) => {
      const firstCol = (selected || 'Column 1').replace(/\n/g, ' ');
      const t = '| ' + firstCol + ' | Column 2 |\n| --- | --- |\n|  |  |';
      const value = before + t + after;
      return { value, pos: before.length + t.length };
    };
  }

  function horizontalRule() {
    return (before, selected, after) => {
      const t = (before && !before.endsWith('\n') ? '\n' : '') + '---' + (after && !after.startsWith('\n') ? '\n' : '');
      const value = before + t + after;
      return { value, pos: before.length + t.length };
    };
  }

  const TOOLBAR = [
    { label: 'H1', title: 'Heading 1', insert: wrapLine('# ', '', 1) },
    { label: 'H2', title: 'Heading 2', insert: wrapLine('## ', '', 2) },
    { label: 'H3', title: 'Heading 3', insert: wrapLine('### ', '', 3) },
    { sep: true },
    { label: 'B', title: 'Bold', insert: wrap('**', '**', 'bold') },
    { label: 'I', title: 'Italic', insert: wrap('_', '_', 'italic') },
    { label: 'S', title: 'Strikethrough', insert: wrap('~~', '~~', 'struck') },
    { label: '`', title: 'Inline code', insert: wrap('`', '`', 'code') },
    { sep: true },
    { label: '❝', title: 'Blockquote', insert: linePrefix('> ', 'quote') },
    { label: '•', title: 'Bullet list', insert: linePrefix('- ', 'item') },
    { label: '1.', title: 'Numbered list', insert: numberedList() },
    { label: '☑', title: 'Task list', insert: linePrefix('- [ ] ', 'task') },
    { sep: true },
    { label: 'Link', title: 'Link', insert: wrap('[', '](https://)', 'text') },
    { label: 'Image', title: 'Image', insert: insertImage() },
    { sep: true },
    { label: '{}', title: 'Code block', insert: codeBlock() },
    { label: '≣', title: 'Table', insert: table() },
    { label: '―', title: 'Horizontal rule', insert: horizontalRule() }
  ];

  function buildToolbar() {
    mdToolbar.innerHTML = '';
    TOOLBAR.forEach((item) => {
      if (item.sep) {
        const div = document.createElement('div');
        div.className = 'sep';
        mdToolbar.appendChild(div);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tb-btn';
      btn.textContent = item.label;
      btn.title = item.title || item.label;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        applyToTextarea(noteContent, item.insert);
        noteContent.focus();
        markDirty();
        renderPreview();
      });
      mdToolbar.appendChild(btn);
    });
  }
  buildToolbar();

  // ---------------- Delete ----------------
  btnDelete.addEventListener('click', async () => {
    const id = state.currentId;
    if (!id) return;
    if (!confirm('Delete this note permanently?')) return;
    try {
      await api('/api/notes/' + encodeURIComponent(id), { method: 'DELETE' });
      state.notes = state.notes.filter((n) => n.id !== id);
      state.currentId = null;
      renderNotes(filterNotes());
      refreshIndex();
      if (state.notes.length > 0) await openNote(state.notes[0].id);
      else showEmpty();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------------- Preview toggle ----------------
  btnPreview.addEventListener('click', () => {
    setPreviewMode(!isPreviewMode());
  });

  noteContent.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type || item.type.indexOf('image/') !== 0) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl !== 'string') return;
        applyToTextarea(noteContent, (before, selected, after) => {
          const snippet = '![](' + dataUrl + ')';
          return { value: before + snippet + after, pos: before.length + snippet.length };
        });
        markDirty();
        renderPreview();
      };
      reader.readAsDataURL(file);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text && isImageUrl(text.trim()) && !(noteContent.value.slice(0, noteContent.selectionStart).endsWith(']('))) {
      e.preventDefault();
      applyToTextarea(noteContent, (before, selected, after) => {
        const url = text.trim();
        const snippet = '![](' + url + ')';
        return { value: before + snippet + after, pos: before.length + snippet.length };
      });
      markDirty();
      renderPreview();
    }
  });

  // ---------------- Share ----------------
  btnShare.addEventListener('click', async () => {
    const id = state.currentId;
    if (!id) return;
    await flushSave();
    shareStatus.textContent = 'Creating...';
    shareStatus.classList.remove('hidden');
    shareModal.classList.remove('hidden');
    try {
      const data = await api('/api/shared', { method: 'POST', body: JSON.stringify({ noteId: id }) });
      state.shareToken = data.token;
      shareUrl.value = location.origin + '/s/' + data.token;
      shareStatus.textContent = '';
    } catch (err) {
      shareStatus.textContent = err.message;
    }
  });

  btnShareCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl.value);
      shareStatus.textContent = 'Copied!';
    } catch {
      shareUrl.select();
      document.execCommand('copy');
      shareStatus.textContent = 'Copied!';
    }
  });

  btnShareCancel.addEventListener('click', () => shareModal.classList.add('hidden'));
  shareModal.addEventListener('click', (e) => {
    if (e.target === shareModal) shareModal.classList.add('hidden');
  });

  // ---------------- Export / save to local ----------------
  function download(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  btnExport.addEventListener('click', async () => {
    if (!state.currentId) return;
    await flushSave();
    const note = currentNote() || await api('/api/notes/' + encodeURIComponent(state.currentId));
    const title = (note.title || 'note').replace(/[\\/:*?"<>|]/g, '_').trim() || 'note';
    const content = note.content || noteContent.value;
    download(`${title}.md`, content);
  });

  // ---------------- WebDAV backup ----------------
  btnBackup.addEventListener('click', async () => {
    if (!state.currentId) return;
    await flushSave();
    btnBackup.disabled = true;
    try {
      const data = await api('/api/backup/' + encodeURIComponent(state.currentId), { method: 'POST' });
      noteSaved.textContent = data.backedUp ? 'Backed up' : 'Backup failed';
    } catch (err) {
      noteSaved.textContent = 'Backup failed';
    }
    btnBackup.disabled = false;
    setTimeout(() => {
      if (!state.dirty) noteSaved.textContent = 'Saved';
    }, 2000);
  });

  // ---------------- Search ----------------
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    renderNotes(filterNotes());
  });

  if (btnToolsToggle) {
    btnToolsToggle.addEventListener('click', () => {
      setToolsCollapsed(!toolsPane.classList.contains('collapsed'), true);
    });
  }

  if (btnBackList) {
    btnBackList.addEventListener('click', async () => {
      await flushSave();
      showMobileList();
    });
  }

  if (typeof mobileMq.addEventListener === 'function') {
    mobileMq.addEventListener('change', syncLayoutMode);
  } else if (typeof mobileMq.addListener === 'function') {
    mobileMq.addListener(syncLayoutMode);
  }

  // ---------------- Init ----------------
  async function init() {
    // Show /api/backup button only if the endpoint is configured
    try {
      const health = await api('/api/health');
      btnBackup.classList.toggle('hidden', !(health && health.webdav && health.webdav.enabled));
    } catch {}
    const authed = await checkAuth();
    if (authed) await showApp();
    else showLogin();
  }

  init();
})();