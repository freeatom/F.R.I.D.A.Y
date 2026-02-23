// ============================================================
// FRIDAY AI – Agent Tools Registry
// All tools FRIDAY can use, with permission gating
// ============================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const security = require('../security/security');
const db = require('../memory/database');

// Lazy-loaded SearchBot — only initialized when first needed
let _searchBot = null;
function getSearchBot() {
    if (!_searchBot) {
        const SearchBot = require('../searchbot/index');
        _searchBot = new SearchBot();
    }
    return _searchBot;
}

function checkPermission(permKey) {
    return db.getConfig(`permissions.${permKey}`) === '1';
}

function getRestrictedPaths() {
    try { return JSON.parse(db.getConfig('restricted_paths') || '[]'); } catch { return []; }
}

function getAllowedPaths() {
    try { return JSON.parse(db.getConfig('allowed_paths') || '[]'); } catch { return []; }
}

const TOOLS = [
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path. Returns the text content.',
        permissionKey: 'file_read',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to the file to read' },
                maxLines: { type: 'number', description: 'Max lines to read (default 200)' },
            },
            required: ['path'],
        },
        execute: async ({ path: filePath, maxLines = 200 }) => {
            const validation = security.validatePath(filePath, getAllowedPaths(), getRestrictedPaths());
            if (!validation.allowed) return { error: validation.reason };
            try {
                const content = fs.readFileSync(validation.resolvedPath, 'utf-8');
                const lines = content.split('\n');
                if (lines.length > maxLines) {
                    return { content: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines: lines.length };
                }
                return { content, truncated: false, totalLines: lines.length };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file. Creates the file if it does not exist.',
        permissionKey: 'file_write',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                content: { type: 'string', description: 'Content to write' },
                append: { type: 'boolean', description: 'If true, append instead of overwrite' },
            },
            required: ['path', 'content'],
        },
        execute: async ({ path: filePath, content, append = false }) => {
            const validation = security.validatePath(filePath, getAllowedPaths(), getRestrictedPaths());
            if (!validation.allowed) return { error: validation.reason };
            try {
                const dir = path.dirname(validation.resolvedPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                if (append) {
                    fs.appendFileSync(validation.resolvedPath, content, 'utf-8');
                } else {
                    fs.writeFileSync(validation.resolvedPath, content, 'utf-8');
                }
                return { success: true, path: validation.resolvedPath };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'list_directory',
        description: 'List files and folders in a directory.',
        permissionKey: 'file_read',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Absolute directory path' },
                recursive: { type: 'boolean', description: 'If true, list recursively (max 100 items)' },
            },
            required: ['path'],
        },
        execute: async ({ path: dirPath, recursive = false }) => {
            const validation = security.validatePath(dirPath, getAllowedPaths(), getRestrictedPaths());
            if (!validation.allowed) return { error: validation.reason };
            try {
                const items = [];
                const walk = (dir, depth = 0) => {
                    if (items.length >= 100) return;
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (items.length >= 100) break;
                        const fullPath = path.join(dir, entry.name);
                        items.push({
                            name: entry.name,
                            path: fullPath,
                            type: entry.isDirectory() ? 'directory' : 'file',
                            size: entry.isFile() ? fs.statSync(fullPath).size : undefined,
                        });
                        if (recursive && entry.isDirectory() && depth < 3) {
                            walk(fullPath, depth + 1);
                        }
                    }
                };
                walk(validation.resolvedPath);
                return { items, totalShown: items.length };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'launch_app',
        description: 'Launch an application or open a file/URL on the system.',
        permissionKey: 'app_launch',
        parameters: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'Path to app, file, or URL to open' },
            },
            required: ['target'],
        },
        execute: async ({ target }) => {
            return new Promise((resolve) => {
                const cmd = process.platform === 'win32' ? `start "" "${target}"` : `open "${target}"`;
                exec(cmd, { timeout: 10000 }, (err) => {
                    if (err) resolve({ error: err.message });
                    else resolve({ success: true, launched: target });
                });
            });
        },
    },
    {
        name: 'get_running_apps',
        description: 'List currently running applications/processes on the PC. Helps understand what the user is working on.',
        permissionKey: 'app_launch',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
            return new Promise((resolve) => {
                const psCmd = `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName, MainWindowTitle, Id, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json -Compress"`;
                exec(psCmd, { timeout: 10000 }, (err, stdout) => {
                    if (err) return resolve({ error: err.message });
                    try {
                        let apps = JSON.parse(stdout || '[]');
                        if (!Array.isArray(apps)) apps = [apps];
                        resolve({
                            apps: apps.map(a => ({
                                name: a.ProcessName,
                                title: a.MainWindowTitle,
                                pid: a.Id,
                                memoryMB: a.MemoryMB
                            })),
                            count: apps.length
                        });
                    } catch { resolve({ error: 'Failed to parse process list' }); }
                });
            });
        },
    },
    {
        name: 'get_active_window',
        description: 'Get the currently focused/active window on the PC.',
        permissionKey: 'app_launch',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
            return new Promise((resolve) => {
                const psCmd = `powershell -NoProfile -Command "Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
    [DllImport(\\"user32.dll\\")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport(\\"user32.dll\\")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    public static string GetTitle() {
        IntPtr h = GetForegroundWindow();
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        return sb.ToString();
    }
}
'@; [FG]::GetTitle()"`;
                exec(psCmd, { timeout: 8000 }, (err, stdout) => {
                    if (err) return resolve({ error: err.message });
                    resolve({ activeWindow: (stdout || '').trim() });
                });
            });
        },
    },
    {
        name: 'get_system_info',
        description: 'Get system information: CPU usage, RAM, disk space, battery status, uptime.',
        permissionKey: 'app_launch',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
            return new Promise((resolve) => {
                const psCmd = `powershell -NoProfile -Command "$cpu = (Get-CimInstance Win32_Processor).LoadPercentage; $os = Get-CimInstance Win32_OperatingSystem; $ramTotal = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $ramFree = [math]::Round($os.FreePhysicalMemory/1MB,1); $disk = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, @{N='SizeGB';E={[math]::Round($_.Size/1GB,1)}}, @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}}; $battery = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue; $uptime = (Get-Date) - $os.LastBootUpTime; @{CPU=$cpu; RAMTotalGB=$ramTotal; RAMFreeGB=$ramFree; Disks=$disk; Battery=@{Percent=$battery.EstimatedChargeRemaining; Charging=$battery.BatteryStatus}; UptimeHours=[math]::Round($uptime.TotalHours,1)} | ConvertTo-Json -Compress -Depth 3"`;
                exec(psCmd, { timeout: 10000 }, (err, stdout) => {
                    if (err) return resolve({ error: err.message });
                    try { resolve(JSON.parse(stdout)); } catch { resolve({ raw: stdout }); }
                });
            });
        },
    },
    {
        name: 'manage_workflow',
        description: 'Save or restore a named workflow (a set of apps to launch together). Use action "save" to save current running apps as a workflow, "restore" to launch all apps in a saved workflow, "list" to see saved workflows, "delete" to remove one.',
        permissionKey: 'app_launch',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'save | restore | list | delete' },
                name: { type: 'string', description: 'Workflow name (e.g. "coding", "design", "morning")' },
                apps: { type: 'array', items: { type: 'string' }, description: 'For save: list of app paths/names to include' },
            },
            required: ['action'],
        },
        execute: async ({ action, name, apps }) => {
            const db = require('../memory/database');
            let workflows = {};
            try { workflows = JSON.parse(db.getConfig('saved_workflows') || '{}'); } catch { }

            switch (action) {
                case 'list':
                    return { workflows, count: Object.keys(workflows).length };
                case 'save': {
                    if (!name) return { error: 'Workflow name required' };
                    workflows[name] = apps || [];
                    db.setConfig('saved_workflows', JSON.stringify(workflows));
                    return { success: true, saved: name, apps: workflows[name] };
                }
                case 'restore': {
                    if (!name || !workflows[name]) return { error: `Workflow "${name}" not found` };
                    const results = [];
                    for (const app of workflows[name]) {
                        const cmd = process.platform === 'win32' ? `start "" "${app}"` : `open "${app}"`;
                        try {
                            exec(cmd, { timeout: 5000 });
                            results.push({ app, status: 'launched' });
                        } catch (e) {
                            results.push({ app, status: 'failed', error: e.message });
                        }
                    }
                    return { success: true, workflow: name, results };
                }
                case 'delete': {
                    if (!name) return { error: 'Workflow name required' };
                    delete workflows[name];
                    db.setConfig('saved_workflows', JSON.stringify(workflows));
                    return { success: true, deleted: name };
                }
                default:
                    return { error: 'Unknown action. Use: save, restore, list, delete' };
            }
        },
    },
    {
        name: 'run_command',
        description: 'Run a shell command and return the output. Use carefully.',
        permissionKey: 'run_command',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The command to execute' },
                cwd: { type: 'string', description: 'Working directory (optional)' },
            },
            required: ['command'],
        },
        execute: async ({ command, cwd }) => {
            const validation = security.validateCommand(command);
            if (!validation.safe) return { error: `Blocked: ${validation.reason}` };
            return new Promise((resolve) => {
                exec(command, { timeout: 30000, cwd: cwd || undefined, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
                    resolve({
                        exitCode: err ? err.code || 1 : 0,
                        stdout: (stdout || '').substring(0, 5000),
                        stderr: (stderr || '').substring(0, 2000),
                    });
                });
            });
        },
    },
    {
        name: 'web_search',
        description: 'Search the web for information. Returns real search results with titles, snippets, and URLs.',
        permissionKey: 'web_search',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
                num_results: { type: 'number', description: 'Number of results (default 5, max 10)' },
            },
            required: ['query'],
        },
        execute: async ({ query, num_results = 5 }) => {
            const https = require('https');
            const limit = Math.min(num_results, 10);

            // Helper: HTTPS GET with proper timeout and redirect handling
            const httpsGet = (url, extraHeaders = {}) => new Promise((resolve, reject) => {
                const parsed = new URL(url);
                const req = https.get({
                    hostname: parsed.hostname,
                    path: parsed.pathname + parsed.search,
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json',
                        ...extraHeaders,
                    },
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        return httpsGet(res.headers.location, extraHeaders).then(resolve).catch(reject);
                    }
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });

            // Strategy 1: You.com Search API (primary — real web results)
            try {
                const youKey = db.getRawConfig('you_search_key') || 'ydc-sk-4a97307ffc2a11fe-jcTXTlL6qpOLwP2HgednQO4WDVANIsye-645304c4';
                const res = await httpsGet(
                    `https://ydc-index.io/v1/search?query=${encodeURIComponent(query)}&count=${limit}`,
                    { 'X-API-Key': youKey }
                );
                const data = JSON.parse(res.data);
                if (data.results && data.results.web && data.results.web.length > 0) {
                    return {
                        query,
                        source: 'You.com',
                        resultCount: data.results.web.length,
                        results: data.results.web.slice(0, limit).map(r => ({
                            title: r.title || '',
                            url: r.url || '',
                            snippet: (r.description || r.snippet || '').substring(0, 300),
                        })),
                        tip: 'Use web_scrape on any URL to get full page content.',
                    };
                }
            } catch { }

            // Strategy 2: DuckDuckGo Instant Answer API (free, no key, factual queries)
            try {
                const res = await httpsGet(
                    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`
                );
                const data = JSON.parse(res.data);
                const results = [];

                if (data.AbstractText) {
                    results.push({
                        title: data.Heading || query,
                        snippet: data.AbstractText.substring(0, 300),
                        url: data.AbstractURL || '',
                    });
                }
                if (data.RelatedTopics) {
                    for (const t of data.RelatedTopics) {
                        if (t.Text && t.FirstURL) {
                            results.push({ title: t.Text.substring(0, 80), snippet: t.Text.substring(0, 200), url: t.FirstURL });
                        }
                        if (t.Topics) {
                            for (const s of t.Topics) {
                                if (s.Text && s.FirstURL) {
                                    results.push({ title: s.Text.substring(0, 80), snippet: s.Text.substring(0, 200), url: s.FirstURL });
                                }
                            }
                        }
                    }
                }
                if (results.length > 0) {
                    return { query, source: 'DuckDuckGo', resultCount: Math.min(results.length, limit), results: results.slice(0, limit) };
                }
            } catch { }

            // Strategy 3: Wikipedia API (always works, good for informational queries)
            try {
                const res = await httpsGet(
                    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&utf8=1`
                );
                const data = JSON.parse(res.data);
                if (data.query && data.query.search && data.query.search.length > 0) {
                    return {
                        query,
                        source: 'Wikipedia',
                        resultCount: data.query.search.length,
                        results: data.query.search.map(r => ({
                            title: r.title,
                            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
                            snippet: r.snippet.replace(/<[^>]+>/g, '').substring(0, 200),
                        })),
                        tip: 'Use web_scrape on any URL to get full page content.',
                    };
                }
            } catch { }

            return {
                error: 'All search strategies failed. Try web_scrape with a direct URL instead.',
                query,
            };
        },
    },
    {
        name: 'get_clipboard',
        description: 'Get the current clipboard text content.',
        permissionKey: 'clipboard',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            const { clipboard } = require('electron');
            return { content: clipboard.readText() };
        },
    },
    {
        name: 'set_clipboard',
        description: 'Set the clipboard text content.',
        permissionKey: 'clipboard',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text to copy to clipboard' },
            },
            required: ['text'],
        },
        execute: async ({ text }) => {
            const { clipboard } = require('electron');
            clipboard.writeText(text);
            return { success: true };
        },
    },
    {
        name: 'manage_reminder',
        description: 'Full CRUD for reminders. Create, list, update, delete, or snooze reminders.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'snooze'], description: 'Action to perform' },
                id: { type: 'number', description: 'Reminder ID (required for update/delete/snooze)' },
                title: { type: 'string', description: 'Reminder title (for create/update)' },
                description: { type: 'string', description: 'Optional description (for create/update)' },
                due_at: { type: 'string', description: 'Due date/time in ISO format YYYY-MM-DDTHH:mm:ss (for create/update/snooze)' },
                recurrence: { type: 'string', description: 'Optional: daily, weekly, monthly (for create/update)' },
                status: { type: 'string', enum: ['pending', 'completed', 'dismissed'], description: 'Status update (for update)' },
                limit: { type: 'number', description: 'Max results for list (default 10)' },
            },
            required: ['action'],
        },
        execute: async (params) => {
            try {
                switch (params.action) {
                    case 'create': {
                        if (!params.title || !params.due_at) {
                            return { error: 'title and due_at are required for creating a reminder' };
                        }
                        const result = db.createReminder(params.title, params.description || '', params.due_at, params.recurrence || null);
                        return { success: true, reminderId: result.lastInsertRowid, title: params.title, due_at: params.due_at };
                    }
                    case 'list': {
                        const reminders = db.getUpcomingReminders(params.limit || 10);
                        return { reminders, count: reminders.length };
                    }
                    case 'update': {
                        if (!params.id) return { error: 'id is required for updating a reminder' };
                        if (params.status) {
                            db.updateReminderStatus(params.id, params.status);
                        }
                        return { success: true };
                    }
                    case 'delete': {
                        if (!params.id) return { error: 'id is required for deleting a reminder' };
                        const result = db.deleteReminder(params.id);
                        return { success: true, deleted: result.changes > 0 };
                    }
                    case 'snooze': {
                        if (!params.id || !params.due_at) return { error: 'id and due_at are required for snoozing' };
                        db.snoozeReminder(params.id, params.due_at);
                        return { success: true, snoozed_until: params.due_at };
                    }
                    default:
                        return { error: `Unknown action '${params.action}'. Use create, list, update, delete, or snooze.` };
                }
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'manage_schedule',
        description: 'Full CRUD for calendar/schedule entries. Create, list, update, or delete schedule entries.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'update', 'delete'], description: 'Action to perform' },
                id: { type: 'number', description: 'Schedule ID (required for update/delete)' },
                title: { type: 'string', description: 'Event title (for create/update)' },
                description: { type: 'string', description: 'Event description (for create/update)' },
                start_time: { type: 'string', description: 'Start date/time in ISO format (for create/update)' },
                end_time: { type: 'string', description: 'End date/time in ISO format (for create/update)' },
                all_day: { type: 'boolean', description: 'All-day event flag (for create/update)' },
                recurrence: { type: 'string', description: 'Recurrence: daily, weekly, monthly (for create/update)' },
                filter: { type: 'string', enum: ['today', 'upcoming', 'all'], description: 'Filter for list action (default: upcoming)' },
                days: { type: 'number', description: 'Number of days ahead for upcoming filter (default 7)' },
            },
            required: ['action'],
        },
        execute: async (params) => {
            try {
                switch (params.action) {
                    case 'create': {
                        if (!params.title || !params.start_time) {
                            return { error: 'title and start_time are required for creating a schedule' };
                        }
                        const result = db.createSchedule(
                            params.title, params.description || '', params.start_time,
                            params.end_time || null, params.all_day || false, params.recurrence || null
                        );
                        return { success: true, scheduleId: result.lastInsertRowid, title: params.title, start_time: params.start_time };
                    }
                    case 'list': {
                        const filter = params.filter || 'upcoming';
                        let schedules;
                        if (filter === 'today') {
                            schedules = db.getTodaySchedules();
                        } else if (filter === 'all') {
                            schedules = db.getAllSchedules(50);
                        } else {
                            schedules = db.getUpcomingSchedules(params.days || 7);
                        }
                        return { schedules, count: schedules.length, filter };
                    }
                    case 'update': {
                        if (!params.id) return { error: 'id is required for updating a schedule' };
                        const updates = {};
                        if (params.title) updates.title = params.title;
                        if (params.description) updates.description = params.description;
                        if (params.start_time) updates.start_time = params.start_time;
                        if (params.end_time) updates.end_time = params.end_time;
                        if (params.all_day !== undefined) updates.all_day = params.all_day;
                        if (params.recurrence !== undefined) updates.recurrence = params.recurrence;
                        const result = db.updateSchedule(params.id, updates);
                        return { success: true, changes: result.changes };
                    }
                    case 'delete': {
                        if (!params.id) return { error: 'id is required for deleting a schedule' };
                        const result = db.deleteSchedule(params.id);
                        return { success: true, deleted: result.changes > 0 };
                    }
                    default:
                        return { error: `Unknown action '${params.action}'. Use create, list, update, or delete.` };
                }
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'manage_goal',
        description: 'Full CRUD for personal goals. Create, update, list, or delete goals to track objectives.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'update', 'list', 'delete'], description: 'Action to perform' },
                title: { type: 'string', description: 'Goal title (for create)' },
                description: { type: 'string', description: 'Goal description' },
                category: { type: 'string', description: 'Category: career, health, learning, personal, etc.' },
                priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Priority level' },
                goal_id: { type: 'number', description: 'Goal ID (for update/delete)' },
                progress: { type: 'number', description: 'Progress 0-100 (for update)' },
                deadline: { type: 'string', description: 'Deadline in ISO format' },
            },
            required: ['action'],
        },
        execute: async (params) => {
            try {
                switch (params.action) {
                    case 'create': {
                        if (!params.title) return { error: 'title is required for creating a goal' };
                        const result = db.createGoal(params.title, params.description, params.category, params.priority, params.deadline);
                        return { success: true, goalId: result.lastInsertRowid };
                    }
                    case 'update': {
                        if (!params.goal_id) return { error: 'goal_id is required for updating a goal' };
                        db.updateGoal(params.goal_id, params);
                        return { success: true };
                    }
                    case 'list':
                        return { goals: db.getActiveGoals() };
                    case 'delete': {
                        if (!params.goal_id) return { error: 'goal_id is required for deleting a goal' };
                        const result = db.deleteGoal(params.goal_id);
                        return { success: true, deleted: result.changes > 0 };
                    }
                    default:
                        return { error: `Unknown action '${params.action}'. Use create, list, update, or delete.` };
                }
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'learn_about_user',
        description: 'Store a fact or preference about the user for future reference.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Fact key (e.g., "favorite_language", "work_hours")' },
                value: { type: 'string', description: 'The value/detail' },
                category: { type: 'string', description: 'Category: preferences, habits, work, personal' },
            },
            required: ['key', 'value'],
        },
        execute: async ({ key, value, category }) => {
            try {
                db.learnAboutUser(key, value, category || 'general');
                return { success: true, stored: { key, value } };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'get_current_datetime',
        description: 'Get the current date, time, and day of week.',
        permissionKey: null,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            const now = new Date();
            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            return {
                date: now.toLocaleDateString('en-IN'),
                time: now.toLocaleTimeString('en-IN'),
                day: days[now.getDay()],
                iso: now.toISOString(),
                timestamp: now.getTime(),
            };
        },
    },
    // ====================== DEFERRED ACTION TOOLS ======================
    {
        name: 'schedule_action',
        description: 'Schedule a tool to execute at a future time. Use this when the user asks to do something later (e.g., "launch Chrome in 5 minutes", "remind me to check email at 3 PM and open Gmail"). ALWAYS use this instead of executing immediately when the user specifies a future time.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                tool_name: { type: 'string', description: 'Name of the tool to execute (e.g., launch_app, run_command, open_url)' },
                tool_params: { type: 'object', description: 'Parameters to pass to the tool when it executes' },
                execute_at: { type: 'string', description: 'ISO datetime when to execute (YYYY-MM-DDTHH:mm:ss). Use get_current_datetime first to calculate the correct time.' },
                delay_minutes: { type: 'number', description: 'Alternative: minutes from now to execute (e.g., 5 for "in 5 minutes")' },
                description: { type: 'string', description: 'Human-readable description of what this action does' },
            },
            required: ['tool_name', 'description'],
        },
        execute: async (params) => {
            try {
                // Validate target tool exists
                const validTools = TOOLS.map(t => t.name);
                if (!validTools.includes(params.tool_name)) {
                    return { error: `Tool '${params.tool_name}' not found. Available: ${validTools.join(', ')}` };
                }

                // Calculate execution time
                let executeAt;
                if (params.delay_minutes) {
                    const future = new Date(Date.now() + params.delay_minutes * 60 * 1000);
                    executeAt = future.toISOString().slice(0, 19).replace('T', ' ');
                } else if (params.execute_at) {
                    executeAt = params.execute_at.replace('T', ' ');
                } else {
                    return { error: 'Either execute_at or delay_minutes is required' };
                }

                const result = db.addDeferredAction(
                    params.tool_name,
                    params.tool_params || {},
                    executeAt,
                    params.description
                );

                return {
                    success: true,
                    actionId: result.lastInsertRowid,
                    tool: params.tool_name,
                    execute_at: executeAt,
                    description: params.description,
                    message: `Scheduled "${params.description}" to execute at ${executeAt}`
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'list_scheduled_actions',
        description: 'List all pending scheduled actions that have not yet been executed.',
        permissionKey: 'scheduling',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const actions = db.listPendingActions();
                return {
                    actions: actions.map(a => ({
                        id: a.id,
                        tool: a.tool_name,
                        description: a.description,
                        execute_at: a.execute_at,
                        created_at: a.created_at,
                    })),
                    count: actions.length,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'cancel_scheduled_action',
        description: 'Cancel a pending scheduled action by its ID.',
        permissionKey: 'scheduling',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'number', description: 'Action ID to cancel' },
            },
            required: ['id'],
        },
        execute: async ({ id }) => {
            try {
                const result = db.cancelDeferredAction(id);
                return { success: true, cancelled: result.changes > 0 };
            } catch (e) { return { error: e.message }; }
        },
    },
    // ====================== SHORTCUT & INTELLIGENCE TOOLS ======================
    {
        name: 'manage_shortcut',
        description: `Manage user shortcuts/trigger phrases. When the user says \"when I say X, do Y\" or you detect a pattern, save it as a shortcut. Next time the trigger is used, you'll automatically know what to do.
Actions: create (save new shortcut), list (show all), delete (remove by ID).
Examples: "when I say 'browser', open Chrome" → saves trigger "browser" → tool launch_app with target Chrome.`,
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'Action to perform' },
                trigger: { type: 'string', description: 'For create: the trigger phrase (e.g., "browser", "work mode")' },
                mapped_action: { type: 'string', description: 'For create: what this shortcut does (human-readable)' },
                tool_name: { type: 'string', description: 'For create: optional tool to execute automatically' },
                tool_params: { type: 'object', description: 'For create: optional tool parameters' },
                id: { type: 'number', description: 'For delete: shortcut ID' },
            },
            required: ['action'],
        },
        execute({ action, trigger, mapped_action, tool_name, tool_params, id }) {
            try {
                switch (action) {
                    case 'create':
                        if (!trigger || !mapped_action) return { error: 'trigger and mapped_action are required' };
                        db.savePattern(trigger, mapped_action, tool_name || null, tool_params || {});
                        return { success: true, message: `Shortcut saved: "${trigger}" → ${mapped_action}` };
                    case 'list':
                        return { shortcuts: db.getTopPatterns(30) };
                    case 'delete':
                        if (!id) return { error: 'id is required for delete' };
                        db.deletePattern(id);
                        return { success: true, message: `Shortcut #${id} deleted` };
                    default:
                        return { error: 'Invalid action. Use create, list, or delete.' };
                }
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'smart_clipboard',
        description: 'Analyze the clipboard contents and detect the content type. Returns what type of content is on the clipboard (URL, email, code, phone, file path, JSON, etc.) and suggests relevant actions. Use this proactively when the user mentions the clipboard or pastes something.',
        permissionKey: 'clipboard',
        parameters: { type: 'object', properties: {} },
        async execute() {
            try {
                const { exec: execCmd } = require('child_process');
                const text = await new Promise((resolve, reject) => {
                    execCmd('powershell -command "Get-Clipboard"', { timeout: 3000 }, (err, stdout) => {
                        if (err) reject(err);
                        else resolve(stdout.trim());
                    });
                });

                if (!text) return { content: null, type: 'empty', suggestions: ['Copy something first'] };

                const analysis = { content: text.substring(0, 500), fullLength: text.length };

                // Detect content type
                if (/^https?:\/\//i.test(text)) {
                    analysis.type = 'url';
                    analysis.suggestions = ['Open in browser (open_url)', 'Scrape content (web_scrape)', 'Save as bookmark'];
                } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                    analysis.type = 'email';
                    analysis.suggestions = ['Send email (send_email)', 'Save as contact (learn_about_user)'];
                } else if (/^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/.test(text)) {
                    analysis.type = 'phone_number';
                    analysis.suggestions = ['Save as contact (learn_about_user)'];
                } else if (/^[A-Z]:\\|^\/[\w]|^~\//.test(text)) {
                    analysis.type = 'file_path';
                    analysis.suggestions = ['Read file (read_file)', 'Open file (launch_app)', 'List directory (list_directory)'];
                } else if (/^\s*[\[{]/.test(text) && /[\]}]\s*$/.test(text)) {
                    try { JSON.parse(text); analysis.type = 'json'; analysis.suggestions = ['Pretty print', 'Analyze structure', 'Save to file']; }
                    catch { analysis.type = 'text'; }
                } else if (/^(import |from |const |let |var |function |class |def |public |private )/.test(text)) {
                    analysis.type = 'code';
                    analysis.suggestions = ['Save to file (write_file)', 'Analyze code', 'Explain code'];
                } else {
                    analysis.type = 'text';
                    analysis.suggestions = ['Save as note (save_note)', 'Search web about this (web_search)', 'Copy to file (write_file)'];
                }

                return analysis;
            } catch (e) { return { error: e.message }; }
        },
    },
    // ====================== NEW AGENTIC TOOLS ======================
    {
        name: 'request_capability',
        description: 'When you need a capability you do not currently have (e.g., email sending, cloud API, external service), use this tool to formally request it from the user. Explain what you need, why, and what minimal credentials/permissions are required. The request is stored and shown to the user.',
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                capability: { type: 'string', description: 'Name of the capability needed (e.g., "email_sending", "google_calendar", "spotify_control")' },
                reason: { type: 'string', description: 'Why you need this capability to complete the task' },
                what_is_needed: { type: 'string', description: 'Exactly what the user needs to provide (e.g., "SMTP server, email, and app password")' },
                setup_plan: { type: 'string', description: 'Brief plan of how you will set it up once granted' },
            },
            required: ['capability', 'reason', 'what_is_needed'],
        },
        execute: async ({ capability, reason, what_is_needed, setup_plan }) => {
            try {
                db.enqueueTask('capability_request', {
                    capability,
                    reason,
                    what_is_needed,
                    setup_plan: setup_plan || 'I will configure it automatically.',
                    status: 'pending',
                    requested_at: new Date().toISOString(),
                });
                db.logActivity('capability_request', `Requested: ${capability} — ${reason}`, 'agent');
                return {
                    success: true,
                    message: `Capability request "${capability}" submitted. The user will be prompted to provide: ${what_is_needed}`,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'send_email',
        description: 'Send an email via SMTP. Requires email credentials to be configured in admin settings. If not configured, use request_capability to ask the user for SMTP credentials first.',
        permissionKey: 'email',
        parameters: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient email address' },
                subject: { type: 'string', description: 'Email subject' },
                body: { type: 'string', description: 'Email body (plain text or HTML)' },
                is_html: { type: 'boolean', description: 'Whether body is HTML' },
            },
            required: ['to', 'subject', 'body'],
        },
        execute: async ({ to, subject, body, is_html = false }) => {
            const smtpHost = db.getRawConfig('email.smtp_host');
            const smtpPort = db.getRawConfig('email.smtp_port') || '587';
            const smtpUser = db.getRawConfig('email.smtp_user');
            const smtpPass = db.getRawConfig('email.smtp_pass');
            const fromAddr = db.getRawConfig('email.from_address') || smtpUser;

            if (!smtpHost || !smtpUser || !smtpPass) {
                return {
                    error: 'Email not configured. SMTP credentials are needed. Please go to Admin > settings to configure email (smtp_host, smtp_user, smtp_pass, from_address), or ask me to request this capability.',
                    needs_setup: true,
                };
            }

            try {
                // Use nodemailer if available, otherwise fallback to raw SMTP
                let nodemailer;
                try { nodemailer = require('nodemailer'); } catch {
                    return {
                        error: 'nodemailer package not installed. Run: npm install nodemailer',
                        needs_install: true,
                    };
                }

                const transporter = nodemailer.createTransport({
                    host: smtpHost,
                    port: parseInt(smtpPort),
                    secure: parseInt(smtpPort) === 465,
                    auth: { user: smtpUser, pass: smtpPass },
                });

                const info = await transporter.sendMail({
                    from: fromAddr,
                    to: to,
                    subject: subject,
                    [is_html ? 'html' : 'text']: body,
                });

                db.logActivity('email_sent', `To: ${to}, Subject: ${subject}`, 'email');
                return { success: true, messageId: info.messageId, to, subject };
            } catch (e) {
                return { error: `Failed to send email: ${e.message}` };
            }
        },
    },
    {
        name: 'save_note',
        description: 'Save a personal note for the user. Notes are stored persistently and can be searched later.',
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Note title' },
                content: { type: 'string', description: 'Note content (markdown supported)' },
                tags: { type: 'string', description: 'Comma-separated tags for categorisation' },
            },
            required: ['title', 'content'],
        },
        execute: async ({ title, content, tags = '' }) => {
            try {
                db.learnAboutUser(`note:${title}`, JSON.stringify({
                    content,
                    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
                    created: new Date().toISOString(),
                }), 'notes');
                db.logActivity('note_saved', title, 'notes');
                return { success: true, title };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'search_notes',
        description: 'Search through saved notes by keyword.',
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search keyword' },
            },
            required: ['query'],
        },
        execute: async ({ query }) => {
            try {
                const profile = db.getUserProfile();
                const notes = profile.filter(p =>
                    p.key.startsWith('note:') &&
                    (p.key.toLowerCase().includes(query.toLowerCase()) ||
                        p.value.toLowerCase().includes(query.toLowerCase()))
                );
                return {
                    results: notes.map(n => {
                        try {
                            const data = JSON.parse(n.value);
                            return { title: n.key.replace('note:', ''), ...data };
                        } catch {
                            return { title: n.key.replace('note:', ''), content: n.value };
                        }
                    }),
                    count: notes.length,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'get_running_processes',
        description: 'Get a list of running processes on the system.',
        permissionKey: 'system_info',
        parameters: {
            type: 'object',
            properties: {
                filter: { type: 'string', description: 'Optional name filter' },
            },
        },
        execute: async ({ filter } = {}) => {
            return new Promise((resolve) => {
                const cmd = process.platform === 'win32'
                    ? 'tasklist /FO CSV /NH'
                    : 'ps aux --no-headers';
                exec(cmd, { timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
                    if (err) return resolve({ error: err.message });
                    let lines = stdout.trim().split('\n');
                    if (filter) {
                        lines = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
                    }
                    resolve({
                        processes: lines.slice(0, 50),
                        total: lines.length,
                        filtered: !!filter,
                    });
                });
            });
        },
    },
    {
        name: 'open_url',
        description: 'Open a URL in the user\'s default browser.',
        permissionKey: 'app_launch',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to open' },
            },
            required: ['url'],
        },
        execute: async ({ url }) => {
            // Validate URL
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
                    return { error: 'Only http, https, and mailto URLs are allowed' };
                }
            } catch {
                return { error: 'Invalid URL format' };
            }

            const { shell } = require('electron');
            try {
                await shell.openExternal(url);
                return { success: true, opened: url };
            } catch (e) {
                return { error: e.message };
            }
        },
    },
    {
        name: 'self_diagnostic',
        description: 'Run a self-diagnostic check on FRIDAY\'s systems — LLM connectivity, database health, permissions, and memory usage. Use this when something seems wrong or when asked about your own status.',
        permissionKey: null,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            const os = require('os');
            const diagnostics = {
                timestamp: new Date().toISOString(),
                system: {
                    memoryUsedMB: ((os.totalmem() - os.freemem()) / 1048576).toFixed(0),
                    memoryTotalMB: (os.totalmem() / 1048576).toFixed(0),
                    uptimeHours: (os.uptime() / 3600).toFixed(1),
                    cpuCores: os.cpus().length,
                },
                database: { status: 'unknown' },
                llm: { status: 'unknown' },
                permissions: {},
                tools: { total: TOOLS.length, enabled: 0 },
            };

            // DB check
            try {
                db.getRecentActivity(1);
                diagnostics.database.status = 'healthy';
            } catch (e) {
                diagnostics.database.status = `error: ${e.message}`;
            }

            // LLM check
            try {
                const llm = require('../llm/provider');
                const status = llm.getStatus();
                diagnostics.llm = {
                    status: (status.groqConfigured || status.openrouterConfigured) ? 'configured' : 'no API keys set',
                    ...status,
                };
            } catch (e) {
                diagnostics.llm.status = `error: ${e.message}`;
            }

            // Permission check
            const permKeys = ['file_read', 'file_write', 'app_launch', 'web_search', 'clipboard', 'scheduling', 'system_info', 'run_command', 'email'];
            for (const key of permKeys) {
                diagnostics.permissions[key] = checkPermission(key) ? 'enabled' : 'disabled';
            }

            // Enabled tools count
            diagnostics.tools.enabled = TOOLS.filter(t =>
                t.permissionKey === null || checkPermission(t.permissionKey)
            ).length;

            // Stored facts
            try {
                diagnostics.userFacts = db.getUserProfile().length;
            } catch { diagnostics.userFacts = 0; }

            // Pending reminders
            try {
                diagnostics.pendingReminders = db.getUpcomingReminders(100).length;
            } catch { diagnostics.pendingReminders = 0; }

            // Active goals
            try {
                diagnostics.activeGoals = db.getActiveGoals().length;
            } catch { diagnostics.activeGoals = 0; }

            return diagnostics;
        },
    },
    {
        name: 'think_and_plan',
        description: 'Use this tool to think through a complex problem step-by-step before acting. Write out your reasoning, break the task into steps, and create an action plan. This helps you be more accurate and thorough.',
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'The task or problem to think through' },
                steps: { type: 'string', description: 'Your step-by-step plan (write it out)' },
                risks: { type: 'string', description: 'Potential risks or failure points' },
                fallback: { type: 'string', description: 'Alternative approach if the main plan fails' },
            },
            required: ['task', 'steps'],
        },
        execute: async ({ task, steps, risks, fallback }) => {
            db.logActivity('planning', `Task: ${task.substring(0, 100)}`, 'agent');
            return {
                acknowledged: true,
                task,
                plan: steps,
                risks: risks || 'None identified',
                fallback: fallback || 'Will improvise based on results',
                advice: 'Now execute your plan step by step. Verify each step before proceeding to the next.',
            };
        },
    },
    // ====================== SKILL LEARNING TOOLS ======================
    {
        name: 'learn_skill',
        description: `CRITICAL TOOL: When the user teaches you how to do something, or when you figure out how to do something new (from web search, experimentation, or user guidance), ALWAYS use this tool to save it as a reusable skill. Next time you encounter a similar task, you'll recall this skill and execute it without needing to be taught again. Skills persist forever across sessions.`,
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Short unique name for the skill (e.g., "send_gmail", "deploy_to_vercel", "create_pdf_report")' },
                description: { type: 'string', description: 'What this skill does, in plain English' },
                steps: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Step-by-step instructions to perform this skill. Be specific and include exact commands, tool calls, or actions needed.',
                },
                category: { type: 'string', description: 'Category: automation, communication, development, research, system, productivity, etc.' },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Searchable tags (e.g., ["email", "gmail", "smtp"])',
                },
                source: { type: 'string', description: 'How you learned this: "user_taught", "web_research", "experimentation", "documentation"' },
            },
            required: ['name', 'description', 'steps'],
        },
        execute: async ({ name, description, steps, category = 'general', tags = [], source = 'user_taught' }) => {
            try {
                const existing = db.getSkill(name);
                db.createSkill(name, description, steps, category, tags, source);
                db.logActivity('skill_learned', `${existing ? 'Updated' : 'Learned'}: ${name} — ${description}`, 'skills');
                return {
                    success: true,
                    action: existing ? 'updated' : 'created',
                    skill: name,
                    description,
                    stepsCount: steps.length,
                    message: existing
                        ? `Skill "${name}" has been updated with improved steps.`
                        : `New skill "${name}" learned and saved! I'll use this automatically next time. 🧠`,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'recall_skill',
        description: `ALWAYS use this tool BEFORE asking the user how to do something. Search your skill memory for relevant procedures. If a matching skill is found, follow its steps. If no skill matches, then try web_search, and only ask the user as a last resort. After using a recalled skill, report whether it succeeded so confidence can be updated.`,
        permissionKey: null,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What you need to do (e.g., "send email via gmail", "convert pdf", "deploy website")' },
                mark_used: { type: 'string', description: 'If using a skill, pass the skill name here to track usage' },
                succeeded: { type: 'boolean', description: 'If mark_used is set, whether the skill worked correctly' },
            },
            required: ['query'],
        },
        execute: async ({ query, mark_used, succeeded }) => {
            // If marking a skill as used, update stats
            if (mark_used) {
                db.recordSkillUsage(mark_used, succeeded !== false);
                return { tracked: true, skill: mark_used, succeeded: succeeded !== false };
            }

            // Search for matching skills
            try {
                const skills = db.searchSkills(query);
                if (skills.length === 0) {
                    return {
                        found: false,
                        message: 'No matching skill found. Try web_search to learn how, or ask the user. If you figure it out, use learn_skill to save it!',
                        suggestion: 'Use web_search or web_scrape to research this, then learn_skill to save the procedure.',
                    };
                }

                return {
                    found: true,
                    count: skills.length,
                    skills: skills.map(s => ({
                        name: s.name,
                        description: s.description,
                        steps: s.steps,
                        confidence: s.confidence,
                        timesUsed: s.times_used,
                        source: s.source,
                        category: s.category,
                    })),
                    advice: `Found ${skills.length} matching skill(s). Use the one with highest confidence. After executing, call recall_skill with mark_used to track success.`,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'list_skills',
        description: 'List all skills you have learned so far. Shows name, description, confidence level, and usage count.',
        permissionKey: null,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const skills = db.getAllSkills();
                if (skills.length === 0) {
                    return { skills: [], message: 'No skills learned yet. I learn by doing — teach me something or let me figure things out!' };
                }
                return {
                    skills: skills.map(s => ({
                        name: s.name,
                        description: s.description,
                        category: s.category,
                        confidence: `${s.confidence}%`,
                        timesUsed: s.times_used,
                        successRate: s.times_used > 0 ? `${Math.round(s.times_succeeded / s.times_used * 100)}%` : 'N/A',
                        source: s.source,
                    })),
                    totalSkills: skills.length,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'web_scrape',
        description: 'Fetch and extract text content from a web page URL. Use this to research how to do something when you don\'t have a matching skill. After learning from a web page, save the procedure as a skill using learn_skill.',
        permissionKey: 'web_search',
        parameters: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'URL to fetch content from' },
                max_length: { type: 'number', description: 'Max characters to return (default 5000)' },
            },
            required: ['url'],
        },
        execute: async ({ url, max_length = 5000 }) => {
            // Validate URL
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return { error: 'Only http and https URLs are allowed' };
                }
            } catch {
                return { error: 'Invalid URL' };
            }

            try {
                const fetch = require('node-fetch');
                const res = await fetch(url, {
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/json,text/plain',
                    },
                });

                if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };

                const contentType = res.headers.get('content-type') || '';
                const raw = await res.text();

                if (contentType.includes('json')) {
                    return { content: raw.substring(0, max_length), type: 'json', url };
                }

                // Strip HTML tags and extract text
                const text = raw
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
                    .replace(/<header[\s\S]*?<\/header>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/&[a-z]+;/gi, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, max_length);

                return { content: text, type: 'html_text', url, length: text.length };
            } catch (e) {
                return { error: `Failed to fetch: ${e.message}` };
            }
        },
    },
    // ==== SearchBot Tools ====
    {
        name: 'search_files',
        description: 'Search for files on the user\'s PC. Searches by file name, content, and metadata. Use this when the user asks to find a file, locate a document, show pictures, etc. Supports type filtering: image, document, code, text, presentation, spreadsheet, or any.',
        permissionKey: 'file_read',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query — file name, content text, or topic' },
                type: { type: 'string', description: 'Filter by type: image, document, code, text, presentation, spreadsheet, any (default: any)' },
                limit: { type: 'number', description: 'Max results to return (default 10)' },
            },
            required: ['query'],
        },
        execute: async ({ query, type = 'any', limit = 10 }) => {
            try {
                const bot = getSearchBot();
                const results = bot.search(query, { type, limit });

                if (results.length === 0) {
                    const status = bot.getStatus();
                    if (status.totalFiles === 0) {
                        return {
                            message: 'No files indexed yet. Run a scan first.',
                            suggestion: 'Use scan_files tool with mode "full" to index the PC.',
                            results: [],
                        };
                    }
                    return { message: 'No matching files found.', query, results: [] };
                }

                return {
                    query,
                    resultCount: results.length,
                    results: results.map(r => ({
                        path: r.path,
                        name: r.name,
                        type: r.file_type,
                        size: r.size,
                        modified: r.modified,
                        preview: (r.match_preview || r.content_preview || '').substring(0, 200),
                    })),
                };
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'scan_files',
        description: 'Trigger SearchBot to scan and index files on the PC. Use "quick" for incremental updates or "full" for a complete re-scan. Run this when the user asks to update the file index or before searching if no files are indexed.',
        permissionKey: 'file_read',
        parameters: {
            type: 'object',
            properties: {
                mode: { type: 'string', description: '"full" for complete scan or "quick" for incremental update' },
                directories: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional specific directories to scan (default: user folders + D:\\)',
                },
            },
            required: ['mode'],
        },
        execute: async ({ mode = 'quick', directories }) => {
            try {
                const bot = getSearchBot();
                if (mode === 'full') {
                    return await bot.startScan(directories || null);
                } else {
                    return await bot.quickScan(directories || null);
                }
            } catch (e) { return { error: e.message }; }
        },
    },
    {
        name: 'searchbot_status',
        description: 'Get SearchBot index status — total files indexed, breakdown by type, and last scan info.',
        permissionKey: null,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const bot = getSearchBot();
                return bot.getStatus();
            } catch (e) { return { error: e.message }; }
        },
    },
    // ==== Plugin Tools ====
    {
        name: 'list_plugins',
        description: 'List all registered plugins/agents connected to FRIDAY.',
        permissionKey: null,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
            try {
                const plugins = db.getAllPlugins();
                return {
                    plugins: plugins.map(p => {
                        let manifest = {};
                        try { manifest = JSON.parse(p.manifest); } catch { }
                        return {
                            name: p.name,
                            description: p.description || manifest.description,
                            enabled: !!p.enabled,
                            path: p.path,
                            capabilities: manifest.capabilities || [],
                        };
                    }),
                    count: plugins.length,
                };
            } catch (e) { return { error: e.message }; }
        },
    },
];


function getToolDefinitions() {
    return TOOLS.filter(t => {
        if (t.permissionKey === null) return true;
        return checkPermission(t.permissionKey);
    }).map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}

async function executeTool(name, args) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return { error: `Unknown tool: ${name}` };

    if (tool.permissionKey !== null && !checkPermission(tool.permissionKey)) {
        return { error: `Permission denied: ${tool.permissionKey} is disabled in admin settings. The user can enable it in the Admin panel.` };
    }

    try {
        const result = await tool.execute(args);
        db.logActivity('tool_call', JSON.stringify({ tool: name, args }).substring(0, 500), name, !result.error);
        return result;
    } catch (e) {
        db.logActivity('tool_error', e.message, name, false);
        return { error: e.message };
    }
}

module.exports = { TOOLS, getToolDefinitions, executeTool };

