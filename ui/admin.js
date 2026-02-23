// ============================================================
// FRIDAY AI – Admin Panel
// Settings, permissions, shortcuts, system health, deferred actions
// ============================================================

class AdminPanel {
    constructor() {
        this.visible = false;
        this.activeTab = 'general';
        this.config = {};
        this.shortcuts = [];
        this.pendingActions = [];
        this.healthData = {};
    }

    async init() {
        await this.loadConfig();
        await this.loadShortcuts();
        await this.loadPendingActions();
    }

    async loadConfig() {
        try {
            const port = window._fridayPort || 47777;
            const res = await fetch(`http://127.0.0.1:${port}/api/config`);
            this.config = await res.json();
        } catch (e) { console.error('Failed to load config:', e); }
    }

    async loadShortcuts() {
        try {
            const port = window._fridayPort || 47777;
            const res = await fetch(`http://127.0.0.1:${port}/api/shortcuts`);
            this.shortcuts = await res.json();
        } catch (e) { this.shortcuts = []; }
    }

    async loadPendingActions() {
        try {
            const port = window._fridayPort || 47777;
            const res = await fetch(`http://127.0.0.1:${port}/api/deferred-actions`);
            this.pendingActions = await res.json();
        } catch (e) { this.pendingActions = []; }
    }

    async saveConfig(key, value) {
        try {
            const port = window._fridayPort || 47777;
            await fetch(`http://127.0.0.1:${port}/api/config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value }),
            });
            this.config[key] = value;
        } catch (e) { console.error('Failed to save config:', e); }
    }

    async deleteShortcut(id) {
        try {
            const port = window._fridayPort || 47777;
            await fetch(`http://127.0.0.1:${port}/api/shortcuts/${id}`, { method: 'DELETE' });
            this.shortcuts = this.shortcuts.filter(s => s.id !== id);
            this.render();
        } catch (e) { console.error('Failed to delete shortcut:', e); }
    }

    render() {
        const container = document.getElementById('admin-panel');
        if (!container) return;

        container.innerHTML = `
            <div class="admin-header">
                <h2>⚙️ FRIDAY Settings</h2>
                <button class="admin-close" onclick="adminPanel.toggle()">✕</button>
            </div>
            <div class="admin-tabs">
                ${this._renderTabs()}
            </div>
            <div class="admin-content">
                ${this._renderTabContent()}
            </div>
        `;
    }

    _renderTabs() {
        const tabs = [
            { id: 'general', label: '🎛️ General', icon: '⚙️' },
            { id: 'permissions', label: '🔒 Permissions', icon: '🔐' },
            { id: 'llm', label: '🧠 LLM', icon: '🤖' },
            { id: 'shortcuts', label: '⚡ Shortcuts', icon: '🎯' },
            { id: 'actions', label: '📋 Actions', icon: '⏰' },
            { id: 'health', label: '💊 Health', icon: '🏥' },
        ];
        return tabs.map(t => `
            <button class="admin-tab${this.activeTab === t.id ? ' active' : ''}"
                    onclick="adminPanel.switchTab('${t.id}')">
                ${t.label}
            </button>
        `).join('');
    }

    switchTab(tab) {
        this.activeTab = tab;
        this.render();
    }

    _renderTabContent() {
        switch (this.activeTab) {
            case 'general': return this._renderGeneralTab();
            case 'permissions': return this._renderPermissionsTab();
            case 'llm': return this._renderLLMTab();
            case 'shortcuts': return this._renderShortcutsTab();
            case 'actions': return this._renderActionsTab();
            case 'health': return this._renderHealthTab();
            default: return '';
        }
    }

    _renderGeneralTab() {
        return `
            <div class="admin-section">
                <h3>Proactive Intelligence</h3>
                ${this._toggle('proactive.enabled', 'Enable Proactive Suggestions')}
                ${this._toggle('proactive.daily_briefing', 'Morning Briefing (8 AM)')}
                <h3>Voice</h3>
                ${this._toggle('voice.enabled', 'Enable Voice Input')}
                <h3>UI</h3>
                ${this._toggle('ui.show_thinking', 'Show Thinking Process')}
                ${this._toggle('ui.show_tool_calls', 'Show Tool Calls')}
            </div>
        `;
    }

    _renderPermissionsTab() {
        const perms = [
            'file_read', 'file_write', 'app_launch', 'run_command',
            'web_search', 'clipboard', 'scheduling', 'system_info'
        ];
        return `
            <div class="admin-section">
                <h3>Tool Permissions</h3>
                <p class="admin-hint">Control what FRIDAY is allowed to do</p>
                ${perms.map(p => this._toggle(`permissions.${p}`, p.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))).join('')}
            </div>
        `;
    }

    _renderLLMTab() {
        const currentProvider = this.config['llm.primary_provider'] || 'groq';
        return `
            <div class="admin-section">
                <h3>LLM Provider</h3>
                <div class="admin-input-row">
                    <label>Primary Provider</label>
                    <select class="admin-input" onchange="adminPanel.saveConfig('llm.primary_provider', this.value)">
                        <option value="openrouter" ${currentProvider === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
                        <option value="groq" ${currentProvider === 'groq' ? 'selected' : ''}>Groq</option>
                    </select>
                </div>
                <h3>OpenRouter</h3>
                ${this._secretInput('llm.openrouter_key', 'OpenRouter API Key', 'sk-or-...')}
                ${this._input('llm.openrouter_model', 'OpenRouter Model', 'google/gemini-2.0-flash-001')}
                <h3>Groq</h3>
                ${this._secretInput('llm.groq_key', 'Groq API Key', 'gsk_...')}
                ${this._input('llm.groq_model', 'Groq Model', 'llama-3.3-70b-versatile')}
                <h3>Web Search</h3>
                ${this._secretInput('you_search_key', 'You.com API Key', 'your-key')}
                <h3>Email (SMTP)</h3>
                ${this._input('email.host', 'SMTP Host', 'smtp.gmail.com')}
                ${this._input('email.port', 'SMTP Port', '587')}
                ${this._input('email.user', 'Email Address', 'your@email.com')}
                ${this._secretInput('email.pass', 'Email Password', '••••••••')}
            </div>
        `;
    }

    _renderShortcutsTab() {
        if (this.shortcuts.length === 0) {
            return `
                <div class="admin-section">
                    <h3>⚡ User Shortcuts</h3>
                    <p class="admin-hint">No shortcuts yet. Tell FRIDAY: "when I say X, do Y" to create one!</p>
                </div>
            `;
        }
        return `
            <div class="admin-section">
                <h3>⚡ User Shortcuts (${this.shortcuts.length})</h3>
                <p class="admin-hint">Tell FRIDAY: "when I say X, do Y" to create shortcuts</p>
                <div class="shortcut-list">
                    ${this.shortcuts.map(s => `
                        <div class="shortcut-item">
                            <div class="shortcut-trigger">"${s.trigger_phrase}"</div>
                            <div class="shortcut-action">→ ${s.mapped_action}</div>
                            <div class="shortcut-meta">Used ${s.use_count}x${s.tool_name ? ` · Tool: ${s.tool_name}` : ''}</div>
                            <button class="shortcut-delete" onclick="adminPanel.deleteShortcut(${s.id})">🗑️</button>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _renderActionsTab() {
        if (this.pendingActions.length === 0) {
            return `
                <div class="admin-section">
                    <h3>📋 Scheduled Actions</h3>
                    <p class="admin-hint">No pending actions. Ask FRIDAY to schedule something!</p>
                </div>
            `;
        }
        return `
            <div class="admin-section">
                <h3>📋 Scheduled Actions (${this.pendingActions.length})</h3>
                <div class="action-list">
                    ${this.pendingActions.map(a => `
                        <div class="action-item ${a.status}">
                            <div class="action-desc">${a.description || a.tool_name}</div>
                            <div class="action-time">⏰ ${new Date(a.execute_at).toLocaleString()}</div>
                            <div class="action-status">${a.status}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    _renderHealthTab() {
        return `
            <div class="admin-section">
                <h3>💊 System Health</h3>
                <p class="admin-hint">FRIDAY monitors your system every 5 minutes</p>
                <div class="health-cards" id="health-cards">
                    <div class="health-card">
                        <div class="health-icon">💾</div>
                        <div class="health-label">Disk Space</div>
                        <div class="health-value" id="health-disk">Checking...</div>
                    </div>
                    <div class="health-card">
                        <div class="health-icon">🧠</div>
                        <div class="health-label">Memory</div>
                        <div class="health-value" id="health-memory">Checking...</div>
                    </div>
                    <div class="health-card">
                        <div class="health-icon">⚡</div>
                        <div class="health-label">CPU</div>
                        <div class="health-value" id="health-cpu">Checking...</div>
                    </div>
                </div>
                <button class="admin-btn" onclick="adminPanel.refreshHealth()">🔄 Refresh</button>
            </div>
        `;
    }

    async refreshHealth() {
        try {
            const port = window._fridayPort || 47777;
            const res = await fetch(`http://127.0.0.1:${port}/api/health/system`);
            const data = await res.json();
            const diskEl = document.getElementById('health-disk');
            const memEl = document.getElementById('health-memory');
            const cpuEl = document.getElementById('health-cpu');
            if (diskEl) diskEl.textContent = data.disk || 'N/A';
            if (memEl) memEl.textContent = data.memory || 'N/A';
            if (cpuEl) cpuEl.textContent = data.cpu || 'N/A';
        } catch (e) {
            console.error('Health check failed:', e);
        }
    }

    // --- Helper Methods ---
    _toggle(key, label) {
        const val = this.config[key] === '1' || this.config[key] === true;
        return `
            <div class="admin-toggle-row">
                <span>${label}</span>
                <label class="admin-switch">
                    <input type="checkbox" ${val ? 'checked' : ''}
                           onchange="adminPanel.saveConfig('${key}', this.checked ? '1' : '0')">
                    <span class="admin-slider"></span>
                </label>
            </div>
        `;
    }

    _input(key, label, placeholder = '', type = 'text') {
        const val = this.config[key] || '';
        return `
            <div class="admin-input-row">
                <label>${label}</label>
                <input type="${type}" value="${val}"
                       placeholder="${placeholder}"
                       onchange="adminPanel.saveConfig('${key}', this.value)"
                       class="admin-input">
            </div>
        `;
    }

    _secretInput(key, label, placeholder = '') {
        const hasValue = !!this.config[key];
        return `
            <div class="admin-input-row">
                <label>${label}</label>
                <div style="display:flex;gap:6px;flex:1">
                    <input type="password" value=""
                           placeholder="${hasValue ? '••••••• (saved)' : placeholder}"
                           id="secret-${key.replace(/\./g, '-')}"
                           class="admin-input" style="flex:1">
                    <button class="admin-btn" onclick="adminPanel.saveSecret('${key}', 'secret-${key.replace(/\./g, '-')}')">Save</button>
                </div>
            </div>
        `;
    }

    async saveSecret(key, inputId) {
        const input = document.getElementById(inputId);
        if (!input) return;
        const val = input.value.trim();
        if (!val || val === '••••••••' || val === '•••••••') {
            if (typeof showToast === 'function') showToast('Enter a new key first', 'warning');
            return;
        }
        await this.saveConfig(key, val);
        input.value = '';
        input.placeholder = '••••••• (saved)';
        if (typeof showToast === 'function') showToast(`${key} saved!`, 'success');
    }

    toggle() {
        this.visible = !this.visible;
        const panel = document.getElementById('admin-panel');
        if (panel) {
            panel.classList.toggle('visible', this.visible);
            if (this.visible) {
                this.init().then(() => this.render());
            }
        }
    }
}

// Global admin panel instance
const adminPanel = new AdminPanel();
