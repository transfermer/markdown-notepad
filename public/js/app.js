/* Markdown Notepad — front-end app. */
(function () {
  'use strict';

  const md = window.markdownit({
    html: true,
    linkify: true,
    breaks: true
  });

  // ---------------- State ----------------
  const state = {
    notes: [],        // list of { id, title, updatedAt }
    currentId: null,
    shareToken: null,
    dirty: false,
    search: '',
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
  const noteContent = $('#note-content');
  const notePreview = $('#note-preview');
  const noteSaved = $('#note-saved');
  const shareModal = $('#share-modal');
  const shareUrl = $('#share-url');
  const shareStatus = $('#share-status');
  const btnShareCopy = $('#btn-share-copy');
  const btnShareCancel = $('#btn-share-cancel');

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
    await refreshNotes();
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
        openNote(state.notes[0].id);
      } else if (state.notes.length === 0) {
        showEmpty();
      }
    } catch (err) {
      // Could be a stale session.
      showLogin(err.message);
    }
  }

  function filterNotes() {
    const q = state.search.trim().toLowerCase();
    if (!q) return state.notes;
    return state.notes.filter((n) => (n.title || '').toLowerCase().includes(q));
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

      const date = document.createElement('div');
      date.className = 'note-date';
      date.textContent = fmtDate(n.updatedAt);

      item.appendChild(title);
      item.appendChild(date);
      li.appendChild(item);
      li.addEventListener('click', () => openNote(n.id));
      noteList.appendChild(li);
    });
    noteCount.textContent = notes.length ? `${notes.length} note${notes.length > 1 ? 's' : ''}` : '';
  }

  function showEmpty() {
    emptyState.classList.remove('hidden');
    editorView.classList.add('hidden');
  }

  // ---------------- Notes: open / create / save ----------------
  async function openNote(id) {
    // Save pending edits in the previous note first.
    await flushSave();
    state.currentId = id;
    renderNotes(filterNotes());
    emptyState.classList.add('hidden');
    editorView.classList.remove('hidden');
    loadNoteIntoUi(id);
  }

  async function loadNoteIntoUi(id) {
    try {
      const note = await api('/api/notes/' + encodeURIComponent(id));
      state.shareToken = null;
      noteTitle.value = note.title || '';
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

  function renderPreview() {
    notePreview.innerHTML = md.render(noteContent.value || '');
  }

  btnNew.addEventListener('click', async () => {
    try {
      const note = await api('/api/notes', {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled', content: '# New note\n\nStart writing…' })
      });
      state.notes.unshift(note);
      await openNote(note.id);
    } catch (err) {
      alert(err.message);
    }
  });

  let contentTimer = null;
  noteContent.addEventListener('input', () => {
    state.dirty = true;
    noteSaved.textContent = 'Unsaved…';
    renderPreview();
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => scheduleSave(), 800);
  });

  noteTitle.addEventListener('input', () => {
    state.dirty = true;
    noteSaved.textContent = 'Unsaved…';
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => scheduleSave(), 800);
  });

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
    try {
      const data = await api('/api/notes/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ title, content })
      });
      state.dirty = false;
      noteSaved.textContent = 'Saved';
      // Update the list row.
      const n = state.notes.find((x) => x.id === id);
      if (n) { n.title = title; n.updatedAt = data.note.updatedAt; }
      renderNotes(filterNotes());
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
      if (state.notes.length > 0) await openNote(state.notes[0].id);
      else showEmpty();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------------- Preview toggle ----------------
  btnPreview.addEventListener('click', () => {
    notePreview.classList.toggle('hidden');
    btnPreview.textContent = notePreview.classList.contains('hidden') ? '👁 Preview' : '✎ Edit';
  });

  // ---------------- Share ----------------
  btnShare.addEventListener('click', async () => {
    const id = state.currentId;
    if (!id) return;
    shareStatus.textContent = 'Creating…';
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