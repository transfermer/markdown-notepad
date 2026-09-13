-- Markdown Notepad — D1 schema
-- Run with:  wrangler d1 execute <db-name> --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'Untitled',
  category   TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes (updated_at DESC);

CREATE TABLE IF NOT EXISTS shares (
  token      TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shares_note ON shares (note_id);

-- Migration for existing installs: add category/tags if the columns don't exist yet.
-- D1 doesn't support IF NOT EXISTS on ADD COLUMN, so this is included as a
-- comment-friendly step; run it once via the console if your notes table was
-- created before this upgrade:
--   ALTER TABLE notes ADD COLUMN category TEXT NOT NULL DEFAULT '';
--   ALTER TABLE notes ADD COLUMN tags    TEXT NOT NULL DEFAULT '[]';