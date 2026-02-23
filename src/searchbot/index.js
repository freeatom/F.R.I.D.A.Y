// ============================================================
// SearchBot — Local PC File Index Agent
// Separate, independent module that FRIDAY uses as a plugin.
//
// Architecture: ON-DEMAND only — no background processes.
// When FRIDAY asks for files, SearchBot wakes up, queries its
// index, and goes back to sleep. Full scans run only when
// explicitly triggered, not in the background.
// ============================================================

const path = require('path');
const fs = require('fs');
const SearchBotDB = require('./database');
const Scanner = require('./scanner');

class SearchBot {
    constructor(dataDir) {
        this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');
        this.db = new SearchBotDB(path.join(this.dataDir, 'searchbot.db'));
        this.scanner = new Scanner(this.db);
        this.isScanning = false;
        this.scanProgress = { scanned: 0, total: 0, status: 'idle' };
    }

    // ---- Plugin manifest (for FRIDAY's plugin system) ----
    static get manifest() {
        return {
            name: 'SearchBot',
            version: '1.0.0',
            description: 'Local PC file search agent — indexes and finds your files intelligently',
            icon: '🔍',
            capabilities: ['file_search', 'file_index'],
            tools: [
                {
                    name: 'search_files',
                    description: 'Search indexed files on the PC by content, name, or type',
                    parameters: {
                        query: 'string — search text',
                        type: 'string — file/image/document/code/any (default: any)',
                        limit: 'number — max results (default: 10)',
                    },
                },
                {
                    name: 'searchbot_status',
                    description: 'Get SearchBot index status',
                },
            ],
        };
    }

    // ---- Core search — this is what FRIDAY calls ----
    search(query, options = {}) {
        const type = options.type || 'any';
        const limit = Math.min(options.limit || 10, 50);
        return this.db.search(query, type, limit);
    }

    // ---- Get status ----
    getStatus() {
        const stats = this.db.getStats();
        return {
            ...stats,
            isScanning: this.isScanning,
            scanProgress: this.scanProgress,
        };
    }

    // ---- Trigger a full scan (on-demand, not background) ----
    async startScan(directories = null) {
        if (this.isScanning) {
            return { message: 'Scan already in progress', progress: this.scanProgress };
        }

        this.isScanning = true;
        this.scanProgress = { scanned: 0, total: 0, status: 'scanning' };

        try {
            // Default: scan user directories
            const dirs = directories || this._getDefaultScanDirs();

            for (const dir of dirs) {
                if (!fs.existsSync(dir)) continue;
                await this.scanner.scanDirectory(dir, (progress) => {
                    this.scanProgress = { ...progress, status: 'scanning' };
                });
            }

            this.scanProgress.status = 'complete';
            this.db.logScan('full_scan', `Scanned ${this.scanProgress.scanned} files`);
            return { success: true, filesScanned: this.scanProgress.scanned };
        } catch (err) {
            this.scanProgress.status = 'error';
            return { error: err.message };
        } finally {
            this.isScanning = false;
        }
    }

    // ---- Quick scan: only check for changes since last scan ----
    async quickScan(directories = null) {
        if (this.isScanning) return { message: 'Scan in progress' };

        this.isScanning = true;
        try {
            const dirs = directories || this._getDefaultScanDirs();
            let updated = 0;
            let removed = 0;

            for (const dir of dirs) {
                if (!fs.existsSync(dir)) continue;
                const result = await this.scanner.quickScan(dir);
                updated += result.updated;
                removed += result.removed;
            }

            this.db.logScan('quick_scan', `Updated: ${updated}, Removed: ${removed}`);
            return { updated, removed };
        } finally {
            this.isScanning = false;
        }
    }

    // ---- Get default directories to scan ----
    _getDefaultScanDirs() {
        const home = process.env.USERPROFILE || process.env.HOME || '';
        const dirs = [];

        // User folders
        const userDirs = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Videos', 'Music'];
        for (const d of userDirs) {
            const p = path.join(home, d);
            if (fs.existsSync(p)) dirs.push(p);
        }

        // Also scan D:\ if it exists (common project drive)
        if (fs.existsSync('D:\\')) {
            dirs.push('D:\\');
        }

        return dirs;
    }

    // ---- Cleanup ----
    close() {
        this.db.close();
    }
}

module.exports = SearchBot;
