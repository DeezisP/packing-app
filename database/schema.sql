-- SQLite schema for PackingRecorder.
-- This file documents the schema; electron/main/services/Database.ts embeds
-- the same statements so the app can self-initialize with zero external files.

CREATE TABLE IF NOT EXISTS recordings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode         TEXT NOT NULL,
  station         TEXT NOT NULL,
  camera          TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  duration_seconds INTEGER,
  video_path      TEXT NOT NULL,
  thumbnail_path  TEXT,
  resolution      TEXT NOT NULL,
  fps             INTEGER NOT NULL,
  bitrate_kbps    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('recording', 'completed', 'interrupted', 'error')),
  created_date    TEXT NOT NULL,
  last_viewed     TEXT
);

CREATE INDEX IF NOT EXISTS idx_recordings_barcode ON recordings (barcode);
CREATE INDEX IF NOT EXISTS idx_recordings_station ON recordings (station);
CREATE INDEX IF NOT EXISTS idx_recordings_camera ON recordings (camera);
CREATE INDEX IF NOT EXISTS idx_recordings_created_date ON recordings (created_date);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings (status);
