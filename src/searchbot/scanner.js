// ============================================================
// SearchBot Scanner — Walks directories and extracts file content
//
// Supports: text files, PDFs, Word docs, PowerPoint, images,
// spreadsheets, and more. Low resource: batch-and-pause scanning.
// ============================================================

const fs = require('fs');
const path = require('path');

// ---- File type classification ----
const TYPE_MAP = {
    // Images
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
    '.bmp': 'image', '.webp': 'image', '.svg': 'image', '.ico': 'image',
    '.tiff': 'image', '.tif': 'image', '.heic': 'image', '.heif': 'image',
    '.raw': 'image', '.cr2': 'image', '.nef': 'image', '.avif': 'image',

    // Documents
    '.pdf': 'document', '.doc': 'document', '.docx': 'document',
    '.odt': 'document', '.rtf': 'document', '.epub': 'document',

    // Presentations
    '.ppt': 'presentation', '.pptx': 'presentation', '.odp': 'presentation',
    '.key': 'presentation',

    // Spreadsheets
    '.xls': 'spreadsheet', '.xlsx': 'spreadsheet', '.csv': 'spreadsheet',
    '.ods': 'spreadsheet', '.tsv': 'spreadsheet',

    // Code
    '.js': 'code', '.ts': 'code', '.py': 'code', '.java': 'code',
    '.c': 'code', '.cpp': 'code', '.h': 'code', '.hpp': 'code',
    '.cs': 'code', '.go': 'code', '.rs': 'code', '.rb': 'code',
    '.php': 'code', '.swift': 'code', '.kt': 'code', '.dart': 'code',
    '.vue': 'code', '.jsx': 'code', '.tsx': 'code', '.sql': 'code',
    '.sh': 'code', '.bat': 'code', '.ps1': 'code', '.r': 'code',
    '.lua': 'code', '.pl': 'code', '.scala': 'code',

    // Text
    '.txt': 'text', '.md': 'text', '.markdown': 'text', '.log': 'text',
    '.ini': 'text', '.cfg': 'text', '.conf': 'text', '.toml': 'text',
    '.yaml': 'text', '.yml': 'text', '.json': 'text', '.xml': 'text',
    '.html': 'text', '.css': 'text', '.env': 'text', '.gitignore': 'text',

    // Archives (metadata only)
    '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive',
    '.gz': 'archive',

    // Audio
    '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio',
    '.ogg': 'audio', '.wma': 'audio', '.m4a': 'audio',

    // Video
    '.mp4': 'video', '.avi': 'video', '.mkv': 'video', '.mov': 'video',
    '.wmv': 'video', '.flv': 'video', '.webm': 'video',
};

// Directories to always skip
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', '__pycache__', '.cache',
    '$Recycle.Bin', 'System Volume Information', 'Recovery',
    'Windows', 'ProgramData', 'Program Files', 'Program Files (x86)',
    'AppData', '.npm', '.nuget', '.gradle', '.m2', '.cargo',
    'bower_components', 'vendor', 'dist', 'build', '.next',
    '.tox', '.venv', 'venv', 'env', '.env', 'tmp', 'temp',
    '.vs', '.idea', '.vscode', 'coverage', '.nyc_output',
    'WindowsApps', 'MicrosoftEdgeBackups',
]);

// Max file size to read content from (10MB)
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;
// Max content preview length
const MAX_PREVIEW_LENGTH = 500;
// Batch size for DB writes
const BATCH_SIZE = 100;
// Pause between batches (ms) — keeps CPU usage low
const BATCH_PAUSE_MS = 50;

class Scanner {
    constructor(db) {
        this.db = db;
    }

    // ---- Full directory scan ----
    async scanDirectory(dirPath, onProgress = null) {
        const batch = [];
        let scanned = 0;

        const walk = async (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return; // Permission denied or inaccessible
            }

            for (const entry of entries) {
                // Skip system/unwanted directories
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                    await walk(path.join(dir, entry.name));
                    continue;
                }

                if (!entry.isFile()) continue;

                const filePath = path.join(dir, entry.name);
                try {
                    const data = await this._extractFileData(filePath);
                    if (data) {
                        batch.push({ filePath, data });
                        scanned++;

                        // Batch write
                        if (batch.length >= BATCH_SIZE) {
                            this.db.upsertBatch(batch.splice(0));
                            if (onProgress) onProgress({ scanned, status: 'scanning' });
                            // Yield CPU
                            await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
                        }
                    }
                } catch {
                    // Skip files that can't be processed
                }
            }
        };

        await walk(dirPath);

        // Flush remaining batch
        if (batch.length > 0) {
            this.db.upsertBatch(batch);
        }
        if (onProgress) onProgress({ scanned, status: 'complete' });
    }

    // ---- Quick scan: only update changed/new files, remove deleted ----
    async quickScan(dirPath) {
        let updated = 0;
        let removed = 0;

        // Get currently indexed paths in this directory
        const indexedPaths = new Set(this.db.getIndexedPaths(dirPath));
        const seenPaths = new Set();
        const batch = [];

        const walk = async (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
                    await walk(path.join(dir, entry.name));
                    continue;
                }

                if (!entry.isFile()) continue;

                const filePath = path.join(dir, entry.name);
                seenPaths.add(filePath);

                try {
                    const stat = fs.statSync(filePath);
                    const modifiedStr = stat.mtime.toISOString();
                    const indexedModified = this.db.getFileModified(filePath);

                    // Only re-index if modified since last index
                    if (!indexedModified || indexedModified !== modifiedStr) {
                        const data = await this._extractFileData(filePath);
                        if (data) {
                            batch.push({ filePath, data });
                            updated++;

                            if (batch.length >= BATCH_SIZE) {
                                this.db.upsertBatch(batch.splice(0));
                                await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
                            }
                        }
                    }
                } catch { }
            }
        };

        await walk(dirPath);

        if (batch.length > 0) {
            this.db.upsertBatch(batch);
        }

        // Remove files that no longer exist
        for (const indexedPath of indexedPaths) {
            if (!seenPaths.has(indexedPath)) {
                this.db.removeFile(indexedPath);
                removed++;
            }
        }

        return { updated, removed };
    }

    // ---- Extract file metadata + content preview ----
    async _extractFileData(filePath) {
        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return null;
        }

        // Skip very large files
        if (stat.size > MAX_CONTENT_SIZE) return null;
        // Skip empty files
        if (stat.size === 0) return null;

        const ext = path.extname(filePath).toLowerCase();
        const name = path.basename(filePath);
        const fileType = TYPE_MAP[ext] || 'other';

        const data = {
            name,
            extension: ext.replace('.', ''),
            size: stat.size,
            modified: stat.mtime.toISOString(),
            file_type: fileType,
            content_preview: '',
            metadata: {},
        };

        // Extract content based on type
        try {
            switch (fileType) {
                case 'text':
                case 'code':
                    data.content_preview = this._readTextPreview(filePath);
                    break;

                case 'document':
                    data.content_preview = await this._extractDocumentText(filePath, ext);
                    break;

                case 'presentation':
                    data.content_preview = await this._extractPresentationText(filePath, ext);
                    break;

                case 'spreadsheet':
                    data.content_preview = await this._extractSpreadsheetText(filePath, ext);
                    break;

                case 'image':
                    data.metadata = this._extractImageMetadata(filePath);
                    data.content_preview = `Image: ${name} | ${data.metadata.dimensions || 'unknown size'} | ${data.metadata.format || ext}`;
                    break;

                case 'audio':
                case 'video':
                    data.metadata = { format: ext.replace('.', ''), fileSize: this._formatSize(stat.size) };
                    data.content_preview = `${fileType}: ${name} | ${data.metadata.fileSize}`;
                    break;

                case 'archive':
                    data.metadata = { format: ext.replace('.', ''), fileSize: this._formatSize(stat.size) };
                    data.content_preview = `Archive: ${name} | ${data.metadata.fileSize}`;
                    break;

                default:
                    // Try reading as text if small enough
                    if (stat.size < 50000) {
                        try {
                            data.content_preview = this._readTextPreview(filePath);
                        } catch { }
                    }
                    break;
            }
        } catch {
            // Content extraction failed — still index the metadata
        }

        return data;
    }

    // ---- Read text file preview ----
    _readTextPreview(filePath) {
        try {
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(MAX_PREVIEW_LENGTH + 100);
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
            fs.closeSync(fd);

            let text = buf.slice(0, bytesRead).toString('utf8');
            // Clean control characters but keep newlines
            text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            return text.substring(0, MAX_PREVIEW_LENGTH).trim();
        } catch {
            return '';
        }
    }

    // ---- Extract text from documents (PDF, DOCX, etc.) ----
    async _extractDocumentText(filePath, ext) {
        if (ext === '.docx') {
            return this._extractDocxText(filePath);
        }
        if (ext === '.pdf') {
            return this._extractPdfText(filePath);
        }
        if (ext === '.rtf') {
            return this._extractRtfText(filePath);
        }
        // For .doc, .odt — read raw bytes and extract readable text
        return this._extractRawText(filePath);
    }

    // ---- Extract text from DOCX (ZIP with XML inside) ----
    _extractDocxText(filePath) {
        try {
            const AdmZip = require('adm-zip');
            const zip = new AdmZip(filePath);
            const docXml = zip.readAsText('word/document.xml');
            if (!docXml) return '';

            // Strip XML tags to get plain text
            const text = docXml
                .replace(/<w:br[^>]*\/>/gi, '\n')
                .replace(/<\/w:p>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/\s+/g, ' ')
                .trim();

            return text.substring(0, MAX_PREVIEW_LENGTH);
        } catch {
            return '';
        }
    }

    // ---- Extract text from PDF (basic extraction) ----
    _extractPdfText(filePath) {
        try {
            // Read raw PDF and extract text between stream markers
            const buf = fs.readFileSync(filePath);
            const str = buf.toString('latin1');

            // Try to extract text from PDF text operators
            const textParts = [];
            const regex = /\(([^)]{1,500})\)/g;
            let match;
            while ((match = regex.exec(str)) !== null && textParts.length < 50) {
                const chunk = match[1].replace(/\\[nrt]/g, ' ').trim();
                if (chunk.length > 2 && /[a-zA-Z0-9]/.test(chunk)) {
                    textParts.push(chunk);
                }
            }

            const text = textParts.join(' ').substring(0, MAX_PREVIEW_LENGTH);
            return text || `PDF document: ${path.basename(filePath)}`;
        } catch {
            return '';
        }
    }

    // ---- Extract text from RTF ----
    _extractRtfText(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            // Strip RTF control words and groups
            const text = content
                .replace(/\{[^}]*\}/g, '')
                .replace(/\\[a-z]+[\d]*\s?/gi, '')
                .replace(/[{}\\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            return text.substring(0, MAX_PREVIEW_LENGTH);
        } catch {
            return '';
        }
    }

    // ---- Extract text from presentations (PPTX) ----
    async _extractPresentationText(filePath, ext) {
        if (ext === '.pptx') {
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(filePath);
                const entries = zip.getEntries();
                const texts = [];

                for (const entry of entries) {
                    if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
                        const xml = zip.readAsText(entry);
                        const slideText = xml
                            .replace(/<\/a:p>/gi, '\n')
                            .replace(/<[^>]+>/g, '')
                            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                            .replace(/&amp;/g, '&')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (slideText) texts.push(slideText);
                    }
                    if (texts.join(' ').length > MAX_PREVIEW_LENGTH) break;
                }

                return texts.join(' | ').substring(0, MAX_PREVIEW_LENGTH);
            } catch {
                return '';
            }
        }
        return this._extractRawText(filePath);
    }

    // ---- Extract text from spreadsheets ----
    async _extractSpreadsheetText(filePath, ext) {
        if (ext === '.csv' || ext === '.tsv') {
            return this._readTextPreview(filePath);
        }
        if (ext === '.xlsx') {
            try {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(filePath);

                // Get shared strings
                let sharedStrings = [];
                try {
                    const ssXml = zip.readAsText('xl/sharedStrings.xml');
                    if (ssXml) {
                        const ssRegex = /<t[^>]*>([^<]+)<\/t>/gi;
                        let m;
                        while ((m = ssRegex.exec(ssXml)) !== null) {
                            sharedStrings.push(m[1]);
                        }
                    }
                } catch { }

                return sharedStrings.slice(0, 100).join(' | ').substring(0, MAX_PREVIEW_LENGTH);
            } catch {
                return '';
            }
        }
        return '';
    }

    // ---- Extract raw readable text from binary files ----
    _extractRawText(filePath) {
        try {
            const buf = fs.readFileSync(filePath);
            // Extract printable ASCII sequences of 4+ characters
            const parts = [];
            let current = '';

            for (let i = 0; i < Math.min(buf.length, 100000); i++) {
                const byte = buf[i];
                if (byte >= 32 && byte <= 126) {
                    current += String.fromCharCode(byte);
                } else {
                    if (current.length >= 4) parts.push(current);
                    current = '';
                }
                if (parts.join(' ').length > MAX_PREVIEW_LENGTH) break;
            }
            if (current.length >= 4) parts.push(current);

            return parts.join(' ').substring(0, MAX_PREVIEW_LENGTH);
        } catch {
            return '';
        }
    }

    // ---- Extract image metadata ----
    _extractImageMetadata(filePath) {
        const meta = { format: path.extname(filePath).replace('.', '').toUpperCase() };

        try {
            // Try reading EXIF from JPEG
            const buf = fs.readFileSync(filePath);

            // Get image dimensions from common formats
            if (buf.length >= 24) {
                // PNG
                if (buf[0] === 0x89 && buf[1] === 0x50) {
                    meta.dimensions = `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
                }
                // JPEG — look for SOF marker
                else if (buf[0] === 0xFF && buf[1] === 0xD8) {
                    let offset = 2;
                    while (offset < buf.length - 8) {
                        if (buf[offset] !== 0xFF) break;
                        const marker = buf[offset + 1];
                        if (marker >= 0xC0 && marker <= 0xC3) {
                            const height = buf.readUInt16BE(offset + 5);
                            const width = buf.readUInt16BE(offset + 7);
                            meta.dimensions = `${width}×${height}`;
                            break;
                        }
                        const len = buf.readUInt16BE(offset + 2);
                        offset += len + 2;
                    }
                }
                // GIF
                else if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
                    meta.dimensions = `${buf.readUInt16LE(6)}×${buf.readUInt16LE(8)}`;
                }
                // BMP
                else if (buf[0] === 0x42 && buf[1] === 0x4D && buf.length >= 26) {
                    meta.dimensions = `${buf.readUInt32LE(18)}×${buf.readUInt32LE(22)}`;
                }
                // WebP
                else if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
                    if (buf.toString('ascii', 12, 16) === 'VP8 ' && buf.length >= 30) {
                        meta.dimensions = `${buf.readUInt16LE(26) & 0x3FFF}×${buf.readUInt16LE(28) & 0x3FFF}`;
                    }
                }
            }

            meta.fileSize = this._formatSize(buf.length);
        } catch { }

        return meta;
    }

    // ---- Format file size ----
    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
    }
}

module.exports = Scanner;
