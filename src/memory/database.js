// ============================================================
// FRIDAY AI – SQLite Database & Memory System
// Persistent storage for conversations, reminders, goals, config
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const security = require('../security/security');

class MemoryDB {
    constructor() {
        this.db = null;
        this.dbPath = null;
    }

    init(dataDir) {
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        this.dbPath = path.join(dataDir, 'friday.db');
        this.db = new Database(this.dbPath);

        // Enable WAL mode for better performance
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this._createTables();
        this._seedDefaults();
    }

    _createTables() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime')),
        session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        due_at DATETIME NOT NULL,
        recurrence TEXT DEFAULT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'fired', 'dismissed', 'snoozed')),
        snooze_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        start_time DATETIME NOT NULL,
        end_time DATETIME,
        all_day INTEGER DEFAULT 0,
        recurrence TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'general',
        priority TEXT DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'critical')),
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'paused', 'abandoned')),
        progress INTEGER DEFAULT 0,
        milestones TEXT DEFAULT '[]',
        deadline DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS user_profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        learned_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS task_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'done', 'failed')),
        result TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        completed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        details TEXT,
        tool_name TEXT,
        success INTEGER DEFAULT 1,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        steps TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        tags TEXT DEFAULT '[]',
        confidence INTEGER DEFAULT 50,
        times_used INTEGER DEFAULT 0,
        times_succeeded INTEGER DEFAULT 0,
        source TEXT DEFAULT 'user_taught',
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
        last_used_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS llm_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        model TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS plugins (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        description TEXT DEFAULT '',
        manifest TEXT DEFAULT '{}',
        enabled INTEGER DEFAULT 1,
        registered_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        properties TEXT DEFAULT '{}',
        importance INTEGER DEFAULT 5,
        access_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
        UNIQUE(type, name)
      );

      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        context TEXT DEFAULT '',
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY(source_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_id) REFERENCES knowledge_nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_topics TEXT DEFAULT '[]',
        entities_mentioned TEXT DEFAULT '[]',
        user_intent TEXT DEFAULT '',
        outcome TEXT DEFAULT '',
        message_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS deferred_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        tool_params TEXT DEFAULT '{}',
        execute_at DATETIME NOT NULL,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'executed', 'failed', 'cancelled')),
        description TEXT DEFAULT '',
        result TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        executed_at DATETIME DEFAULT NULL
      );

      CREATE TABLE IF NOT EXISTS interaction_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_phrase TEXT NOT NULL,
        mapped_action TEXT NOT NULL,
        tool_name TEXT DEFAULT NULL,
        tool_params TEXT DEFAULT '{}',
        use_count INTEGER DEFAULT 1,
        last_used DATETIME DEFAULT (datetime('now', 'localtime')),
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS chat_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_at, status);
      CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_time);
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
      CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_timestamp ON llm_usage(timestamp);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_provider ON llm_usage(provider);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_type ON knowledge_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_name ON knowledge_nodes(name);
      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON knowledge_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON knowledge_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_session ON conversation_summaries(session_id);
      CREATE INDEX IF NOT EXISTS idx_deferred_actions_execute ON deferred_actions(execute_at, status);
      CREATE INDEX IF NOT EXISTS idx_interaction_patterns_trigger ON interaction_patterns(trigger_phrase);
    `);
    }

    _seedDefaults() {
        const defaults = {
            'permissions.file_read': '1',
            'permissions.file_write': '1',
            'permissions.app_launch': '1',
            'permissions.web_search': '1',
            'permissions.clipboard': '1',
            'permissions.scheduling': '1',
            'permissions.system_info': '1',
            'permissions.run_command': '0',
            'permissions.email': '0',
            'restricted_paths': '[]',
            'allowed_paths': '[]',
            'llm.primary_provider': 'groq',
            'llm.openrouter_key': '',
            'llm.groq_key': '',
            'llm.openrouter_model': 'google/gemini-2.0-flash-001',
            'llm.groq_model': 'llama-3.3-70b-versatile',
            'voice.enabled': '1',
            'voice.auto_speak': '0',
            'proactive.enabled': '1',
            'proactive.daily_briefing': '1',
            'ui.theme': 'dark',
        };

        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO config (key, value, encrypted) VALUES (?, ?, ?)'
        );

        for (const [key, value] of Object.entries(defaults)) {
            const isSecret = key.includes('_key');
            const storedValue = isSecret && value ? security.encrypt(value) : value;
            stmt.run(key, storedValue, isSecret ? 1 : 0);
        }
    }

    // --- Config ---
    getConfig(key) {
        const row = this.db.prepare('SELECT value, encrypted FROM config WHERE key = ?').get(key);
        if (!row) return null;
        if (row.encrypted && row.value) {
            const decrypted = security.decrypt(row.value);
            return decrypted !== null ? decrypted : row.value;
        }
        return row.value;
    }

    setConfig(key, value) {
        const isSecret = key.includes('_key');
        const storedValue = isSecret && value ? security.encrypt(value) : value;
        this.db.prepare(
            'INSERT OR REPLACE INTO config (key, value, encrypted) VALUES (?, ?, ?)'
        ).run(key, storedValue, isSecret ? 1 : 0);
    }

    getAllConfig() {
        const rows = this.db.prepare('SELECT key, value, encrypted FROM config').all();
        const config = {};
        for (const row of rows) {
            if (row.encrypted && row.value) {
                const decrypted = security.decrypt(row.value);
                // Mask secrets for frontend display
                config[row.key] = decrypted ? '••••••••' + decrypted.slice(-4) : '';
            } else {
                config[row.key] = row.value;
            }
        }
        return config;
    }

    getRawConfig(key) {
        const row = this.db.prepare('SELECT value, encrypted FROM config WHERE key = ?').get(key);
        if (!row) return null;
        if (row.encrypted && row.value) {
            return security.decrypt(row.value) || '';
        }
        return row.value;
    }

    // --- Conversations ---
    addMessage(role, content, sessionId) {
        return this.db.prepare(
            'INSERT INTO conversations (role, content, session_id) VALUES (?, ?, ?)'
        ).run(role, content, sessionId);
    }

    getRecentMessages(sessionId, limit = 20) {
        return this.db.prepare(
            'SELECT role, content, timestamp FROM conversations WHERE session_id = ? ORDER BY id DESC LIMIT ?'
        ).all(sessionId, limit).reverse();
    }

    getConversationHistory(limit = 50) {
        return this.db.prepare(
            'SELECT role, content, timestamp, session_id FROM conversations ORDER BY id DESC LIMIT ?'
        ).all(limit).reverse();
    }

    // --- Reminders ---
    createReminder(title, description, dueAt, recurrence = null) {
        return this.db.prepare(
            'INSERT INTO reminders (title, description, due_at, recurrence) VALUES (?, ?, ?, ?)'
        ).run(title, description || '', dueAt, recurrence);
    }

    getDueReminders() {
        return this.db.prepare(
            "SELECT * FROM reminders WHERE status = 'pending' AND due_at <= datetime('now', 'localtime')"
        ).all();
    }

    getUpcomingReminders(limit = 10) {
        return this.db.prepare(
            "SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at ASC LIMIT ?"
        ).all(limit);
    }

    updateReminderStatus(id, status) {
        return this.db.prepare(
            'UPDATE reminders SET status = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?'
        ).run(status, id);
    }

    snoozeReminder(id, newDueAt) {
        return this.db.prepare(
            "UPDATE reminders SET due_at = ?, snooze_count = snooze_count + 1, updated_at = datetime('now', 'localtime') WHERE id = ?"
        ).run(newDueAt, id);
    }

    deleteReminder(id) {
        return this.db.prepare('DELETE FROM reminders WHERE id = ?').run(id);
    }

    // --- Schedules ---
    createSchedule(title, description, startTime, endTime, allDay = false, recurrence = null) {
        return this.db.prepare(
            'INSERT INTO schedules (title, description, start_time, end_time, all_day, recurrence) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(title, description || '', startTime, endTime || null, allDay ? 1 : 0, recurrence);
    }

    getTodaySchedules() {
        return this.db.prepare(
            "SELECT * FROM schedules WHERE date(start_time) = date('now', 'localtime') ORDER BY start_time ASC"
        ).all();
    }

    getUpcomingSchedules(days = 7) {
        return this.db.prepare(
            "SELECT * FROM schedules WHERE start_time >= datetime('now', 'localtime') AND start_time <= datetime('now', 'localtime', '+' || ? || ' days') ORDER BY start_time ASC"
        ).all(days);
    }

    deleteSchedule(id) {
        return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    }

    updateSchedule(id, updates) {
        const fields = [];
        const values = [];
        if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
        if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
        if (updates.start_time !== undefined) { fields.push('start_time = ?'); values.push(updates.start_time); }
        if (updates.end_time !== undefined) { fields.push('end_time = ?'); values.push(updates.end_time); }
        if (updates.all_day !== undefined) { fields.push('all_day = ?'); values.push(updates.all_day ? 1 : 0); }
        if (updates.recurrence !== undefined) { fields.push('recurrence = ?'); values.push(updates.recurrence); }
        if (fields.length === 0) return { changes: 0 };
        values.push(id);
        return this.db.prepare(`UPDATE schedules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    getAllSchedules(limit = 50) {
        return this.db.prepare(
            "SELECT * FROM schedules ORDER BY start_time DESC LIMIT ?"
        ).all(limit);
    }

    // --- Goals ---
    createGoal(title, description, category, priority, deadline) {
        return this.db.prepare(
            'INSERT INTO goals (title, description, category, priority, deadline) VALUES (?, ?, ?, ?, ?)'
        ).run(title, description || '', category || 'general', priority || 'medium', deadline || null);
    }

    getActiveGoals() {
        return this.db.prepare(
            "SELECT * FROM goals WHERE status = 'active' ORDER BY priority DESC, created_at ASC"
        ).all();
    }

    updateGoalProgress(id, progress) {
        const status = progress >= 100 ? 'completed' : 'active';
        return this.db.prepare(
            "UPDATE goals SET progress = ?, status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?"
        ).run(Math.min(100, Math.max(0, progress)), status, id);
    }

    updateGoal(id, fields) {
        const allowed = ['title', 'description', 'category', 'priority', 'status', 'progress', 'milestones', 'deadline'];
        const updates = [];
        const values = [];
        for (const [k, v] of Object.entries(fields)) {
            if (allowed.includes(k)) {
                updates.push(`${k} = ?`);
                values.push(v);
            }
        }
        if (updates.length === 0) return;
        updates.push("updated_at = datetime('now', 'localtime')");
        values.push(id);
        return this.db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    deleteGoal(id) {
        return this.db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    }

    // --- Deferred Actions ---
    addDeferredAction(toolName, toolParams, executeAt, description = '') {
        return this.db.prepare(
            'INSERT INTO deferred_actions (tool_name, tool_params, execute_at, description) VALUES (?, ?, ?, ?)'
        ).run(toolName, JSON.stringify(toolParams), executeAt, description);
    }

    getDueActions() {
        return this.db.prepare(
            "SELECT * FROM deferred_actions WHERE status = 'pending' AND execute_at <= datetime('now', 'localtime')"
        ).all();
    }

    updateActionStatus(id, status, result = null) {
        return this.db.prepare(
            "UPDATE deferred_actions SET status = ?, result = ?, executed_at = datetime('now', 'localtime') WHERE id = ?"
        ).run(status, result, id);
    }

    cancelDeferredAction(id) {
        return this.db.prepare(
            "UPDATE deferred_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
        ).run(id);
    }

    listPendingActions() {
        return this.db.prepare(
            "SELECT * FROM deferred_actions WHERE status = 'pending' ORDER BY execute_at ASC"
        ).all();
    }

    // --- Interaction Patterns (Shortcuts) ---
    savePattern(triggerPhrase, mappedAction, toolName = null, toolParams = {}) {
        const existing = this.db.prepare('SELECT * FROM interaction_patterns WHERE trigger_phrase = ?').get(triggerPhrase.toLowerCase());
        if (existing) {
            return this.db.prepare(
                'UPDATE interaction_patterns SET mapped_action = ?, tool_name = ?, tool_params = ?, use_count = use_count + 1, last_used = datetime("now", "localtime") WHERE id = ?'
            ).run(mappedAction, toolName, JSON.stringify(toolParams), existing.id);
        }
        return this.db.prepare(
            'INSERT INTO interaction_patterns (trigger_phrase, mapped_action, tool_name, tool_params) VALUES (?, ?, ?, ?)'
        ).run(triggerPhrase.toLowerCase(), mappedAction, toolName, JSON.stringify(toolParams));
    }

    findPattern(phrase) {
        const lower = phrase.toLowerCase();
        return this.db.prepare(
            'SELECT * FROM interaction_patterns WHERE ? LIKE \'%\' || trigger_phrase || \'%\' ORDER BY use_count DESC LIMIT 5'
        ).all(lower);
    }

    getTopPatterns(limit = 20) {
        return this.db.prepare(
            'SELECT * FROM interaction_patterns ORDER BY use_count DESC LIMIT ?'
        ).all(limit);
    }

    deletePattern(id) {
        return this.db.prepare('DELETE FROM interaction_patterns WHERE id = ?').run(id);
    }

    incrementPatternUsage(id) {
        return this.db.prepare(
            'UPDATE interaction_patterns SET use_count = use_count + 1, last_used = datetime("now", "localtime") WHERE id = ?'
        ).run(id);
    }

    // --- Chat State (Persistent) ---
    saveChatState(key, value) {
        return this.db.prepare(
            'INSERT OR REPLACE INTO chat_state (key, value, updated_at) VALUES (?, ?, datetime("now", "localtime"))'
        ).run(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    loadChatState(key) {
        const row = this.db.prepare('SELECT value FROM chat_state WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    getAllChatState() {
        return this.db.prepare('SELECT * FROM chat_state').all();
    }

    // --- Daily Stats ---
    getDailyStats() {
        const today = new Date().toISOString().slice(0, 10);
        const toolCalls = this.db.prepare(
            "SELECT COUNT(*) as count FROM activity_log WHERE date(timestamp) = ? AND type = 'tool_call'"
        ).get(today);
        const messages = this.db.prepare(
            "SELECT COUNT(*) as count FROM messages WHERE date(timestamp) = ?"
        ).get(today);
        const actions = this.db.prepare(
            "SELECT COUNT(*) as count FROM deferred_actions WHERE date(executed_at) = ? AND status = 'executed'"
        ).get(today);
        return {
            toolCallsToday: toolCalls?.count || 0,
            messagesToday: messages?.count || 0,
            actionsExecutedToday: actions?.count || 0,
        };
    }

    // --- User Profile ---
    learnAboutUser(key, value, category = 'general') {
        return this.db.prepare(
            'INSERT OR REPLACE INTO user_profile (key, value, category) VALUES (?, ?, ?)'
        ).run(key, value, category);
    }

    getUserProfile() {
        return this.db.prepare('SELECT * FROM user_profile ORDER BY category, key').all();
    }

    getUserFact(key) {
        const row = this.db.prepare('SELECT value FROM user_profile WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    // --- Task Queue ---
    enqueueTask(type, payload) {
        return this.db.prepare(
            'INSERT INTO task_queue (type, payload) VALUES (?, ?)'
        ).run(type, JSON.stringify(payload));
    }

    getQueuedTasks(limit = 10) {
        return this.db.prepare(
            "SELECT * FROM task_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?"
        ).all(limit);
    }

    updateTaskStatus(id, status, result = null) {
        return this.db.prepare(
            "UPDATE task_queue SET status = ?, result = ?, completed_at = datetime('now', 'localtime') WHERE id = ?"
        ).run(status, result, id);
    }

    // --- Activity Log ---
    logActivity(action, details, toolName = null, success = true) {
        return this.db.prepare(
            'INSERT INTO activity_log (action, details, tool_name, success) VALUES (?, ?, ?, ?)'
        ).run(action, details || '', toolName, success ? 1 : 0);
    }

    getRecentActivity(limit = 50) {
        return this.db.prepare(
            'SELECT * FROM activity_log ORDER BY id DESC LIMIT ?'
        ).all(limit);
    }

    // --- Skills ---
    createSkill(name, description, steps, category = 'general', tags = [], source = 'user_taught') {
        return this.db.prepare(
            'INSERT OR REPLACE INTO skills (name, description, steps, category, tags, source, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime(\'now\', \'localtime\'))'
        ).run(name, description, JSON.stringify(steps), category, JSON.stringify(tags), source, source === 'user_taught' ? 80 : 50);
    }

    getSkill(name) {
        const row = this.db.prepare('SELECT * FROM skills WHERE name = ?').get(name);
        if (row) {
            try { row.steps = JSON.parse(row.steps); } catch { }
            try { row.tags = JSON.parse(row.tags); } catch { }
        }
        return row;
    }

    searchSkills(query) {
        const rows = this.db.prepare(
            `SELECT * FROM skills WHERE
             name LIKE ? OR description LIKE ? OR tags LIKE ? OR category LIKE ?
             ORDER BY confidence DESC, times_used DESC LIMIT 10`
        ).all(`%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`);
        return rows.map(r => {
            try { r.steps = JSON.parse(r.steps); } catch { }
            try { r.tags = JSON.parse(r.tags); } catch { }
            return r;
        });
    }

    getAllSkills() {
        const rows = this.db.prepare('SELECT id, name, description, category, confidence, times_used, times_succeeded, source, last_used_at FROM skills ORDER BY times_used DESC').all();
        return rows;
    }

    recordSkillUsage(name, succeeded) {
        const skill = this.getSkill(name);
        if (!skill) return;
        const newTimesUsed = skill.times_used + 1;
        const newTimesSucceeded = skill.times_succeeded + (succeeded ? 1 : 0);
        // Confidence goes up with success, down with failure
        const successRate = newTimesSucceeded / newTimesUsed;
        const newConfidence = Math.min(100, Math.max(10, Math.round(successRate * 100)));
        this.db.prepare(
            `UPDATE skills SET
             times_used = ?, times_succeeded = ?, confidence = ?,
             last_used_at = datetime('now', 'localtime'),
             updated_at = datetime('now', 'localtime')
             WHERE name = ?`
        ).run(newTimesUsed, newTimesSucceeded, newConfidence, name);
    }

    updateSkillSteps(name, steps) {
        this.db.prepare(
            "UPDATE skills SET steps = ?, updated_at = datetime('now', 'localtime') WHERE name = ?"
        ).run(JSON.stringify(steps), name);
    }

    deleteSkill(name) {
        return this.db.prepare('DELETE FROM skills WHERE name = ?').run(name);
    }

    // ---- LLM Usage Tracking ----
    recordLLMUsage(provider, model, usage) {
        this.db.prepare(
            `INSERT INTO llm_usage (provider, model, prompt_tokens, completion_tokens, total_tokens)
             VALUES (?, ?, ?, ?, ?)`
        ).run(
            provider,
            model || '',
            usage.prompt_tokens || 0,
            usage.completion_tokens || 0,
            usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
        );
    }

    getLLMUsage(days = 7) {
        const rows = this.db.prepare(
            `SELECT provider, model,
                    SUM(prompt_tokens) as total_prompt,
                    SUM(completion_tokens) as total_completion,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as call_count
             FROM llm_usage
             WHERE timestamp >= datetime('now', 'localtime', ?)
             GROUP BY provider`
        ).all(`-${days} days`);

        const daily = this.db.prepare(
            `SELECT DATE(timestamp) as date, provider,
                    SUM(total_tokens) as tokens,
                    COUNT(*) as calls
             FROM llm_usage
             WHERE timestamp >= datetime('now', 'localtime', ?)
             GROUP BY DATE(timestamp), provider
             ORDER BY date`
        ).all(`-${days} days`);

        const today = this.db.prepare(
            `SELECT SUM(total_tokens) as tokens, COUNT(*) as calls
             FROM llm_usage
             WHERE DATE(timestamp) = DATE('now', 'localtime')`
        ).get();

        return { byProvider: rows, daily, today: today || { tokens: 0, calls: 0 } };
    }

    // ---- Plugin Management ----
    registerPlugin(name, pluginPath, description, manifest) {
        this.db.prepare(
            `INSERT OR REPLACE INTO plugins (name, path, description, manifest, enabled)
             VALUES (?, ?, ?, ?, 1)`
        ).run(name, pluginPath, description, JSON.stringify(manifest));
    }

    getPlugin(name) {
        return this.db.prepare('SELECT * FROM plugins WHERE name = ?').get(name);
    }

    getAllPlugins() {
        return this.db.prepare('SELECT * FROM plugins ORDER BY registered_at DESC').all();
    }

    setPluginEnabled(name, enabled) {
        this.db.prepare('UPDATE plugins SET enabled = ? WHERE name = ?').run(enabled ? 1 : 0, name);
    }

    removePlugin(name) {
        return this.db.prepare('DELETE FROM plugins WHERE name = ?').run(name);
    }

    // ---- Knowledge Graph ----
    addKnowledgeNode(type, name, description = '', properties = {}, importance = 5) {
        try {
            this.db.prepare(
                `INSERT INTO knowledge_nodes (type, name, description, properties, importance)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(type, name) DO UPDATE SET
                   description = CASE WHEN excluded.description != '' THEN excluded.description ELSE knowledge_nodes.description END,
                   properties = excluded.properties,
                   importance = MAX(knowledge_nodes.importance, excluded.importance),
                   access_count = knowledge_nodes.access_count + 1,
                   updated_at = datetime('now', 'localtime')`
            ).run(type, name, description, JSON.stringify(properties), importance);

            return this.db.prepare('SELECT id FROM knowledge_nodes WHERE type = ? AND name = ?').get(type, name)?.id;
        } catch { return null; }
    }

    addKnowledgeEdge(sourceId, targetId, relation, weight = 1.0, context = '') {
        try {
            this.db.prepare(
                `INSERT OR REPLACE INTO knowledge_edges (source_id, target_id, relation, weight, context)
                 VALUES (?, ?, ?, ?, ?)`
            ).run(sourceId, targetId, relation, weight, context);
        } catch { }
    }

    getKnowledgeNodes(type = null, limit = 50) {
        if (type) {
            return this.db.prepare(
                'SELECT * FROM knowledge_nodes WHERE type = ? ORDER BY importance DESC, access_count DESC LIMIT ?'
            ).all(type, limit);
        }
        return this.db.prepare(
            'SELECT * FROM knowledge_nodes ORDER BY importance DESC, access_count DESC LIMIT ?'
        ).all(limit);
    }

    searchKnowledgeNodes(query) {
        const pattern = `%${query}%`;
        return this.db.prepare(
            `SELECT * FROM knowledge_nodes
             WHERE name LIKE ? OR description LIKE ?
             ORDER BY importance DESC, access_count DESC LIMIT 20`
        ).all(pattern, pattern);
    }

    getRelatedNodes(nodeId) {
        return this.db.prepare(
            `SELECT kn.*, ke.relation, ke.weight, ke.context
             FROM knowledge_edges ke
             JOIN knowledge_nodes kn ON (kn.id = ke.target_id OR kn.id = ke.source_id)
             WHERE (ke.source_id = ? OR ke.target_id = ?) AND kn.id != ?
             ORDER BY ke.weight DESC LIMIT 20`
        ).all(nodeId, nodeId, nodeId);
    }

    getTopKnowledgeNodes(limit = 20) {
        return this.db.prepare(
            `SELECT * FROM knowledge_nodes
             ORDER BY importance DESC, access_count DESC, updated_at DESC
             LIMIT ?`
        ).all(limit);
    }

    // ---- Conversation Summaries ----
    addConversationSummary(sessionId, summary, keyTopics = [], entities = [], userIntent = '', outcome = '', messageCount = 0) {
        this.db.prepare(
            `INSERT INTO conversation_summaries
             (session_id, summary, key_topics, entities_mentioned, user_intent, outcome, message_count)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(sessionId, summary, JSON.stringify(keyTopics), JSON.stringify(entities), userIntent, outcome, messageCount);
    }

    getRecentSummaries(limit = 10) {
        return this.db.prepare(
            `SELECT * FROM conversation_summaries
             ORDER BY created_at DESC LIMIT ?`
        ).all(limit);
    }

    getSessionIds(limit = 20) {
        return this.db.prepare(
            `SELECT DISTINCT session_id, MIN(timestamp) as started_at, MAX(timestamp) as last_at, COUNT(*) as message_count
             FROM conversations
             GROUP BY session_id
             ORDER BY last_at DESC
             LIMIT ?`
        ).all(limit);
    }

    getSessionMessages(sessionId, limit = 50) {
        return this.db.prepare(
            'SELECT * FROM conversations WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?'
        ).all(sessionId, limit);
    }

    close() {
        if (this.db) this.db.close();
    }
}

module.exports = new MemoryDB();
