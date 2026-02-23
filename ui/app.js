// ============================================================
// FRIDAY AI – Main App Logic
// Chat UI, WebSocket, Dashboard, Toast, Tab Management
// ============================================================

(function () {
    'use strict';

    const API_BASE = `http://127.0.0.1:47777`;
    const WS_URL = `ws://127.0.0.1:47777`;

    // ---- State ----
    let ws = null;
    let isConnected = false;
    let isProcessing = false;
    let currentAssistantBubble = null;

    // ---- DOM Refs ----
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send');
    const btnStop = document.getElementById('btn-stop');
    const btnMic = document.getElementById('btn-mic');
    const btnMin = document.getElementById('btn-min');
    const btnMax = document.getElementById('btn-max');
    const btnClose = document.getElementById('btn-close');
    const btnPin = document.getElementById('btn-pin');
    const inputStatus = document.getElementById('input-status');
    const toastContainer = document.getElementById('toast-container');

    // ---- Init ----
    async function init() {
        setupTabs();
        setupTitlebar();
        setupChat();
        setupVoice();
        connectWebSocket();
        setupQuickActions();
        setupIPC();
        setupNewChat();
        setupAdmin();

        // Init admin panel
        const admin = new window.AdminPanel(API_BASE);
        await admin.init();

        // Load dashboard data
        loadDashboard();

        // Periodically refresh dashboard
        setInterval(loadDashboard, 60000);
    }

    // ---- Admin Settings (index.html tab) ----
    function setupAdmin() {
        // Helper: save a config key
        async function saveKey(key, value) {
            try {
                const res = await fetch(`${API_BASE}/api/config`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key, value }),
                });
                const data = await res.json();
                if (data.success) showToast(`${key} saved!`, 'success');
                else showToast(`Failed: ${data.error}`, 'error');
            } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
        }

        // Load existing config into fields
        fetch(`${API_BASE}/api/config`).then(r => r.json()).then(cfg => {
            const providerSelect = document.getElementById('cfg-primary-provider');
            if (providerSelect && cfg['llm.primary_provider']) {
                providerSelect.value = cfg['llm.primary_provider'];
            }
            const groqModel = document.getElementById('cfg-groq-model');
            if (groqModel && cfg['llm.groq_model']) groqModel.value = cfg['llm.groq_model'];
            const orModel = document.getElementById('cfg-openrouter-model');
            if (orModel && cfg['llm.openrouter_model']) orModel.value = cfg['llm.openrouter_model'];

            // Show LLM status
            const statusEl = document.getElementById('llm-status');
            if (statusEl) {
                const primary = cfg['llm.primary_provider'] || 'groq';
                const hasGroq = !!cfg['llm.groq_key'];
                const hasOR = !!cfg['llm.openrouter_key'];
                statusEl.innerHTML = `Primary: <strong>${primary}</strong> | Groq: ${hasGroq ? '✅' : '❌'} | OpenRouter: ${hasOR ? '✅' : '❌'}`;
            }
        }).catch(() => { });

        // Provider dropdown
        const providerSelect = document.getElementById('cfg-primary-provider');
        if (providerSelect) {
            providerSelect.addEventListener('change', () => saveKey('llm.primary_provider', providerSelect.value));
        }

        // Save Groq key
        const btnSaveGroq = document.getElementById('btn-save-groq');
        if (btnSaveGroq) {
            btnSaveGroq.addEventListener('click', () => {
                const val = document.getElementById('cfg-groq-key')?.value?.trim();
                if (!val) return showToast('Enter a key first', 'warning');
                saveKey('llm.groq_key', val);
            });
        }

        // Save OpenRouter key
        const btnSaveOR = document.getElementById('btn-save-or');
        if (btnSaveOR) {
            btnSaveOR.addEventListener('click', () => {
                const val = document.getElementById('cfg-openrouter-key')?.value?.trim();
                if (!val) return showToast('Enter a key first', 'warning');
                saveKey('llm.openrouter_key', val);
            });
        }

        // Toggle show/hide groq key
        const btnToggleGroq = document.getElementById('btn-toggle-groq');
        if (btnToggleGroq) {
            btnToggleGroq.addEventListener('click', () => {
                const input = document.getElementById('cfg-groq-key');
                if (input) { input.type = input.type === 'password' ? 'text' : 'password'; btnToggleGroq.textContent = input.type === 'password' ? 'Show' : 'Hide'; }
            });
        }

        // Toggle show/hide OpenRouter key
        const btnToggleOR = document.getElementById('btn-toggle-or');
        if (btnToggleOR) {
            btnToggleOR.addEventListener('click', () => {
                const input = document.getElementById('cfg-openrouter-key');
                if (input) { input.type = input.type === 'password' ? 'text' : 'password'; btnToggleOR.textContent = input.type === 'password' ? 'Show' : 'Hide'; }
            });
        }

        // Save models on change
        const groqModel = document.getElementById('cfg-groq-model');
        if (groqModel) groqModel.addEventListener('change', () => saveKey('llm.groq_model', groqModel.value));
        const orModel = document.getElementById('cfg-openrouter-model');
        if (orModel) orModel.addEventListener('change', () => saveKey('llm.openrouter_model', orModel.value));
    }

    // ---- Tabs ----
    function setupTabs() {
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');

                if (tab.dataset.tab === 'dashboard') loadDashboard();
            });
        });
    }

    // ---- Titlebar ----
    function setupTitlebar() {
        if (window.friday) {
            btnMin?.addEventListener('click', () => window.friday.minimize());
            btnMax?.addEventListener('click', () => window.friday.maximize());
            btnClose?.addEventListener('click', () => window.friday.close());
            btnPin?.addEventListener('click', async () => {
                const pinned = await window.friday.toggleAlwaysOnTop();
                btnPin.classList.toggle('pinned', pinned);
                showToast(pinned ? 'Pinned on top' : 'Unpinned', 'info');
            });
        }
    }

    // ---- IPC (Electron events) ----
    function setupIPC() {
        if (!window.friday) return;

        window.friday.onNotification((data) => {
            showToast(`⏰ ${data.title}`, 'info', data.description);
            // Also add to chat
            addMessage('assistant', `⏰ **Reminder:** ${data.title}${data.description ? '\n' + data.description : ''}`);
        });

        window.friday.onProactive((data) => {
            addMessage('assistant', data.content);
            showToast('FRIDAY has an update', 'info');
        });

        window.friday.onNewSession(() => {
            chatMessages.innerHTML = '';
            addWelcomeMessage();
        });
    }

    // ---- Chat ----
    function setupChat() {
        // Auto-resize textarea
        chatInput.addEventListener('input', () => {
            chatInput.style.height = 'auto';
            chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
        });

        // Send on Enter (Shift+Enter for newline)
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });

        btnSend.addEventListener('click', sendMessage);
        btnStop.addEventListener('click', stopResponse);
    }

    function sendMessage() {
        const text = chatInput.value.trim();
        if (!text || isProcessing) return;

        addMessage('user', text);
        chatInput.value = '';
        chatInput.style.height = 'auto';

        // Remove welcome message if present
        const welcome = chatMessages.querySelector('.welcome-message');
        if (welcome) welcome.remove();

        // Send via WebSocket
        if (ws && isConnected) {
            isProcessing = true;
            btnSend.style.display = 'none';
            btnStop.style.display = 'flex';
            setStatus('FRIDAY is thinking...', true);

            // Create assistant bubble for streaming
            currentAssistantBubble = createStreamingBubble();

            ws.send(JSON.stringify({ type: 'chat', content: text }));
        } else {
            addMessage('assistant', 'Connection lost. Attempting to reconnect... 🔄');
            connectWebSocket();
        }
    }

    function stopResponse() {
        if (ws && isConnected) {
            ws.send(JSON.stringify({ type: 'abort' }));
        }
        isProcessing = false;
        btnSend.style.display = 'flex';
        btnStop.style.display = 'none';
        setStatus('', false);
    }

    function addMessage(role, content) {
        const msg = document.createElement('div');
        msg.className = `message ${role}`;

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.innerHTML = renderMarkdown(content);

        const ts = document.createElement('div');
        ts.className = 'msg-timestamp';
        ts.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        msg.appendChild(bubble);
        msg.appendChild(ts);
        chatMessages.appendChild(msg);
        scrollToBottom();
        return bubble;
    }

    function createStreamingBubble() {
        const msg = document.createElement('div');
        msg.className = 'message assistant';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';

        const ts = document.createElement('div');
        ts.className = 'msg-timestamp';
        ts.textContent = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        msg.appendChild(bubble);
        msg.appendChild(ts);
        chatMessages.appendChild(msg);
        scrollToBottom();
        return bubble;
    }

    function addWelcomeMessage() {
        chatMessages.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-orb-container"><div class="welcome-orb"></div></div>
        <h2>Hello, I'm <span class="gradient-text">FRIDAY</span></h2>
        <p>Your personal AI assistant. I remember everything and learn from every conversation.</p>
        <div class="quick-actions">
          <button class="quick-btn" data-msg="What's on my schedule today?">📅 Today's Schedule</button>
          <button class="quick-btn" data-msg="Show my active goals">🎯 My Goals</button>
          <button class="quick-btn" data-msg="What apps am I running right now?">💻 My Apps</button>
          <button class="quick-btn" data-msg="Help me plan my day">🧠 Plan My Day</button>
          <button class="quick-btn" data-msg="Check my system status">📊 System Status</button>
          <button class="quick-btn" data-msg="What do you know about me?">🧠 My Memory</button>
        </div>
      </div>
    `;
        setupQuickActions();
    }

    // ---- New Chat ----
    function setupNewChat() {
        const btnNewChat = document.getElementById('btn-new-chat');
        if (btnNewChat) {
            btnNewChat.addEventListener('click', () => {
                if (ws && isConnected) {
                    ws.send(JSON.stringify({ type: 'new_chat' }));
                }
                // Reset UI immediately
                chatMessages.innerHTML = '';
                addWelcomeMessage();
                currentAssistantBubble = null;
                isProcessing = false;
                btnSend.style.display = 'flex';
                btnStop.style.display = 'none';
                setStatus('', false);
                showToast('New conversation started ✨', 'info');
            });
        }
    }

    // ---- Quick Actions ----
    function setupQuickActions() {
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                chatInput.value = btn.dataset.msg;
                sendMessage();
            });
        });
    }

    // ---- WebSocket ----
    function connectWebSocket() {
        if (ws && ws.readyState === WebSocket.OPEN) return;

        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            setStatus('Failed to connect', false);
            return;
        }

        ws.onopen = () => {
            isConnected = true;
            setStatus('Connected ✨', false);
            setTimeout(() => setStatus('', false), 2000);
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                handleWSMessage(data);
            } catch (e) { /* ignore */ }
        };

        ws.onclose = () => {
            isConnected = false;
            setStatus('Disconnected – reconnecting...', false);
            setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = () => {
            isConnected = false;
        };
    }

    function handleWSMessage(data) {
        switch (data.type) {
            case 'connected':
                break;

            case 'chunk':
                if (currentAssistantBubble) {
                    // Remove typing indicator on first chunk
                    const typing = currentAssistantBubble.querySelector('.typing-indicator');
                    if (typing) {
                        currentAssistantBubble.innerHTML = '';
                        currentAssistantBubble._content = '';
                    }
                    currentAssistantBubble._content = (currentAssistantBubble._content || '') + data.content;
                    currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantBubble._content);
                    scrollToBottom();
                }
                break;

            case 'thinking':
                // Show collapsible thinking section before the response
                if (currentAssistantBubble) {
                    const thinkEl = document.createElement('div');
                    thinkEl.className = 'thinking-section';
                    thinkEl.innerHTML = `
                        <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
                            <span class="thinking-icon">💭</span>
                            <span class="thinking-label">Thinking...</span>
                            <span class="thinking-toggle">▸</span>
                        </div>
                        <div class="thinking-content">${renderMarkdown(data.content)}</div>
                    `;
                    // Insert before the assistant bubble
                    const parentMsg = currentAssistantBubble.parentElement;
                    if (parentMsg) {
                        parentMsg.insertBefore(thinkEl, currentAssistantBubble);
                    }
                    scrollToBottom();
                }
                break;

            case 'new_session':
                break;

            case 'tool_start':
                if (currentAssistantBubble) {
                    const badge = document.createElement('div');
                    badge.className = 'tool-badge';
                    badge.textContent = `⚙️ ${data.tool}`;
                    chatMessages.insertBefore(createToolMsg(badge), currentAssistantBubble.parentElement);
                }
                setStatus(`Using tool: ${data.tool}`, true);
                break;

            case 'tool_end':
                if (data.result?.error) {
                    const badge = document.createElement('div');
                    badge.className = 'tool-badge error';
                    badge.textContent = `❌ ${data.tool}: ${data.result.error}`;
                    if (currentAssistantBubble) {
                        chatMessages.insertBefore(createToolMsg(badge), currentAssistantBubble.parentElement);
                    }
                }
                break;

            case 'done':
                isProcessing = false;
                btnSend.style.display = 'flex';
                btnStop.style.display = 'none';
                setStatus('', false);

                if (currentAssistantBubble && data.content) {
                    currentAssistantBubble.innerHTML = renderMarkdown(data.content);
                    scrollToBottom();

                    // Auto-speak if enabled
                    if (window.voiceEngine && window.fridayAutoSpeak) {
                        window.voiceEngine.speak(data.content);
                    }
                }
                currentAssistantBubble = null;
                break;

            case 'error':
                isProcessing = false;
                btnSend.style.display = 'flex';
                btnStop.style.display = 'none';
                setStatus('', false);
                if (currentAssistantBubble) {
                    currentAssistantBubble.innerHTML = renderMarkdown(data.content || 'An error occurred.');
                }
                currentAssistantBubble = null;
                break;
        }
    }

    function createToolMsg(badge) {
        const div = document.createElement('div');
        div.style.cssText = 'display:flex;justify-content:flex-start;padding:0 4px;';
        div.appendChild(badge);
        return div;
    }

    // ---- Voice ----
    function setupVoice() {
        if (!window.voiceEngine?.isSupported) {
            btnMic.style.display = 'none';
            return;
        }

        window.voiceEngine.onResult = (text, isFinal) => {
            if (isFinal) {
                chatInput.value = text;
                sendMessage();
            } else {
                chatInput.value = text;
            }
        };

        window.voiceEngine.onStatusChange = (listening) => {
            btnMic.classList.toggle('listening', listening);
            setStatus(listening ? '🎙️ Listening... speak now' : '', listening);
        };

        btnMic.addEventListener('click', () => {
            window.voiceEngine.toggleListening();
        });
    }

    // ---- Dashboard ----
    async function loadDashboard() {
        try {
            const [goalsRes, remindersRes, schedulesRes, activityRes] = await Promise.all([
                fetch(`${API_BASE}/api/goals`).then(r => r.json()).catch(() => []),
                fetch(`${API_BASE}/api/reminders`).then(r => r.json()).catch(() => []),
                fetch(`${API_BASE}/api/schedules?days=7`).then(r => r.json()).catch(() => []),
                fetch(`${API_BASE}/api/activity?limit=20`).then(r => r.json()).catch(() => []),
            ]);

            renderGoals(goalsRes);
            renderReminders(remindersRes);
            renderSchedules(schedulesRes);
            renderActivity(activityRes);
        } catch (e) { /* silently fail */ }
    }

    function renderGoals(goals) {
        const container = document.getElementById('goals-list');
        const badge = document.getElementById('goals-count');
        if (!container) return;
        badge.textContent = goals.length;

        if (goals.length === 0) {
            container.innerHTML = '<div class="empty-state">No goals yet. Ask FRIDAY to set one!</div>';
            return;
        }

        container.innerHTML = goals.map(g => `
      <div class="dash-item">
        <span class="dash-item-title">${escapeHtml(g.title)}</span>
        <div class="goal-progress"><div class="goal-progress-fill" style="width:${g.progress}%"></div></div>
        <span class="dash-item-meta">${g.progress}%</span>
      </div>
    `).join('');
    }

    function renderReminders(reminders) {
        const container = document.getElementById('reminders-list');
        const badge = document.getElementById('reminders-count');
        if (!container) return;
        badge.textContent = reminders.length;

        if (reminders.length === 0) {
            container.innerHTML = '<div class="empty-state">No reminders. Ask FRIDAY to create one!</div>';
            return;
        }

        container.innerHTML = reminders.map(r => `
      <div class="dash-item">
        <span class="dash-item-title">${escapeHtml(r.title)}</span>
        <span class="dash-item-meta">${formatDateTime(r.due_at)}</span>
        <button class="dash-item-delete" data-reminder-id="${r.id}" title="Delete">×</button>
      </div>
    `).join('');

        // Bind delete buttons
        container.querySelectorAll('.dash-item-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                await fetch(`${API_BASE}/api/reminders/${btn.dataset.reminderId}`, { method: 'DELETE' });
                loadDashboard();
            });
        });
    }

    function renderSchedules(schedules) {
        const container = document.getElementById('schedule-list');
        if (!container) return;

        if (schedules.length === 0) {
            container.innerHTML = '<div class="empty-state">No events scheduled.</div>';
            return;
        }

        container.innerHTML = schedules.map(s => `
      <div class="dash-item">
        <span class="dash-item-title">${escapeHtml(s.title)}</span>
        <span class="dash-item-meta">${formatDateTime(s.start_time)}</span>
      </div>
    `).join('');
    }

    function renderActivity(activities) {
        const container = document.getElementById('activity-list');
        if (!container) return;

        if (activities.length === 0) {
            container.innerHTML = '<div class="empty-state">No recent activity.</div>';
            return;
        }

        container.innerHTML = activities.slice(0, 15).map(a => `
      <div class="activity-item">
        <div class="activity-dot ${a.success ? 'success' : 'error'}"></div>
        <span class="activity-text">${escapeHtml(a.action)}${a.tool_name ? ` (${a.tool_name})` : ''}</span>
        <span class="activity-time">${formatTime(a.timestamp)}</span>
      </div>
    `).join('');
    }

    // ---- Utilities ----
    function scrollToBottom() {
        requestAnimationFrame(() => {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        });
    }

    function setStatus(text, active) {
        if (inputStatus) {
            inputStatus.textContent = text;
            inputStatus.className = active ? 'input-status active' : 'input-status';
        }
    }

    function showToast(title, type = 'info', body = '') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${body ? `<div class="toast-body">${escapeHtml(body)}</div>` : ''}`;
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            toast.style.transition = '0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // Expose globally
    window.showToast = showToast;

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function renderMarkdown(text) {
        if (!text) return '';

        // Escape HTML first
        let html = escapeHtml(text);

        // Code blocks
        html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
        });

        // Inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold
        html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Italic
        html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Headers
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        // Blockquotes
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        // Lists
        html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');

        // Links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // Paragraphs (double newline)
        html = html.replace(/\n\n/g, '</p><p>');

        // Single newlines
        html = html.replace(/\n/g, '<br>');

        // Wrap in paragraph
        html = `<p>${html}</p>`;

        // Clean empty paragraphs
        html = html.replace(/<p><\/p>/g, '');

        return html;
    }

    function formatDateTime(str) {
        if (!str) return '';
        try {
            const d = new Date(str);
            return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' ' +
                d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        } catch { return str; }
    }

    function formatTime(str) {
        if (!str) return '';
        try {
            return new Date(str).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        } catch { return str; }
    }

    // ---- Boot ----
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
