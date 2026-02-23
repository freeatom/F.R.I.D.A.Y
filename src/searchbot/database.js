// ============================================================
// SearchBot Database — SQLite + FTS5 for full-text file search
// Separate database from FRIDAY's main DB for independence.
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class SearchBotDB {
    constructor(dbPath) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                extension TEXT DEFAULT '',
                size INTEGER DEFAULT 0,
                modified TEXT,
                content_preview TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                file_type TEXT DEFAULT 'other',
                indexed_at TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS scan_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                details TEXT DEFAULT '',
                timestamp TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
            CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
            CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type);
        `);

        // FTS5 virtual table for full-text search
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
                    name,
                    content_preview,
                    path,
                    content='files',
                    content_rowid='rowid'
                );
            `);

            // Triggers to keep FTS in sync
            this.db.exec(`
                CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                    INSERT INTO files_fts(rowid, name, content_preview, path)
                    VALUES (new.rowid, new.name, new.content_preview, new.path);
                END;

                CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                    INSERT INTO files_fts(files_fts, rowid, name, content_preview, path)
                    VALUES('delete', old.rowid, old.name, old.content_preview, old.path);
                END;

                CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                    INSERT INTO files_fts(files_fts, rowid, name, content_preview, path)
                    VALUES('delete', old.rowid, old.name, old.content_preview, old.path);
                    INSERT INTO files_fts(rowid, name, content_preview, path)
                    VALUES (new.rowid, new.name, new.content_preview, new.path);
                END;
            `);
        } catch (e) {
            // FTS5 triggers may already exist
        }
    }

    // ---- Upsert a file into the index ----
    upsertFile(filePath, data) {
        // First check if it exists (for trigger hygiene)
        const existing = this.db.prepare('SELECT path FROM files WHERE path = ?').get(filePath);

        if (existing) {
            this.db.prepare(`
                UPDATE files SET name = ?, extension = ?, size = ?, modified = ?,
                content_preview = ?, metadata = ?, file_type = ?,
                indexed_at = datetime('now', 'localtime')
                WHERE path = ?
            `).run(
                data.name, data.extension, data.size, data.modified,
                data.content_preview || '', JSON.stringify(data.metadata || {}),
                data.file_type || 'other', filePath
            );
        } else {
            this.db.prepare(`
                INSERT INTO files (path, name, extension, size, modified, content_preview, metadata, file_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                filePath, data.name, data.extension, data.size, data.modified,
                data.content_preview || '', JSON.stringify(data.metadata || {}),
                data.file_type || 'other'
            );
        }
    }

    // ---- Batch upsert for performance ----
    upsertBatch(files) {
        const tx = this.db.transaction((items) => {
            for (const { filePath, data } of items) {
                this.upsertFile(filePath, data);
            }
        });
        tx(files);
    }

    // ---- Remove a file ----
    removeFile(filePath) {
        this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
    }

    // ---- Full-text search ----
    search(query, type = 'any', limit = 10) {
        // Escape FTS5 special characters and add wildcard
        const escaped = query.replace(/['"*]/g, '').trim();
        if (!escaped) return [];

        let sql;
        const params = [];

        if (type === 'any') {
            sql = `
                SELECT f.path, f.name, f.extension, f.size, f.modified,
                       f.content_preview, f.metadata, f.file_type,
                       highlight(files_fts, 1, '**', '**') AS match_preview
                FROM files_fts fts
                JOIN files f ON f.rowid = fts.rowid
                WHERE files_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            `;
            params.push(`"${escaped}"*`, limit);
        } else {
            sql = `
                SELECT f.path, f.name, f.extension, f.size, f.modified,
                       f.content_preview, f.metadata, f.file_type,
                       highlight(files_fts, 1, '**', '**') AS match_preview
                FROM files_fts fts
                JOIN files f ON f.rowid = fts.rowid
                WHERE files_fts MATCH ? AND f.file_type = ?
                ORDER BY rank
                LIMIT ?
            `;
            params.push(`"${escaped}"*`, type, limit);
        }

        try {
            return this.db.prepare(sql).all(...params);
        } catch {
            // Fallback: LIKE-based search if FTS fails
            return this.db.prepare(`
                SELECT path, name, extension, size, modified,
                       content_preview, metadata, file_type,
                       '' as match_preview
                FROM files
                WHERE name LIKE ? OR content_preview LIKE ?
                ${type !== 'any' ? 'AND file_type = ?' : ''}
                LIMIT ?
            `).all(`%${escaped}%`, `%${escaped}%`, ...(type !== 'any' ? [type] : []), limit);
        }
    }

    // ---- Check if a file is already indexed ----
    hasFile(filePath) {
        return !!this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(filePath);
    }

    // ---- Get file modified time from index ----
    getFileModified(filePath) {
        const row = this.db.prepare('SELECT modified FROM files WHERE path = ?').get(filePath);
        return row ? row.modified : null;
    }

    // ---- Get all indexed paths in a directory ----
    getIndexedPaths(directory) {
        return this.db.prepare(
            "SELECT path FROM files WHERE path LIKE ? || '%'"
        ).all(directory).map(r => r.path);
    }

    // ---- Stats ----
    getStats() {
        const total = this.db.prepare('SELECT COUNT(*) as c FROM files').get();
        const byType = this.db.prepare(
            'SELECT file_type, COUNT(*) as count FROM files GROUP BY file_type ORDER BY count DESC'
        ).all();
        const lastScan = this.db.prepare(
            'SELECT * FROM scan_log ORDER BY id DESC LIMIT 1'
        ).get();

        return {
            totalFiles: total.c,
            byType,
            lastScan: lastScan || null,
        };
    }

    // ---- Log a scan event ----
    logScan(action, details) {
        this.db.prepare(
            'INSERT INTO scan_log (action, details) VALUES (?, ?)'
        ).run(action, details);
    }

    // ---- Get scan log ----
    getScanLog(limit = 20) {
        return this.db.prepare(
            'SELECT * FROM scan_log ORDER BY id DESC LIMIT ?'
        ).all(limit);
    }

    close() {
        if (this.db) this.db.close();
    }
}

module.exports = SearchBotDB;
