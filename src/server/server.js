// ============================================================
// FRIDAY AI – Express + WebSocket Server
// API for chat, admin config, and real-time streaming
// ============================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const security = require('../security/security');
const db = require('../memory/database');
const AgentEngine = require('../agent/engine');
const llm = require('../llm/provider');

class FridayServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.wss = null;
        this.agent = new AgentEngine();
        this.clients = new Set();
        this.sessionToken = security.generateToken();
        this.port = 47777;
    }

    init() {
        // Security middleware
        const cspHeaders = security.getCSPHeaders();
        this.app.use((req, res, next) => {
            for (const [header, value] of Object.entries(cspHeaders)) {
                res.setHeader(header, value);
            }
            next();
        });

        // Body parsing with size limits
        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.urlencoded({ extended: false, limit: '1mb' }));

        // Serve static UI files
        this.app.use(express.static(path.join(__dirname, '../../ui'), {
            dotfiles: 'deny',
            index: false,
        }));

        // Serve index.html at root
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../../ui/index.html'));
        });

        // Setup routes
        this._setupRoutes();

        // Create HTTP + WebSocket server
        this.server = http.createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });
        this._setupWebSocket();
    }

    _setupRoutes() {
        // --- Health check ---
        this.app.get('/api/health', (req, res) => {
            res.json({ status: 'ok', name: 'FRIDAY AI', uptime: process.uptime() });
        });

        // --- Chat (REST fallback) ---
        this.app.post('/api/chat', async (req, res) => {
            const { message } = req.body;
            if (!message || typeof message !== 'string') {
                return res.status(400).json({ error: 'Message is required' });
            }
            try {
                const result = await this.agent.process(security.sanitizeInput(message));
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // --- Config / Admin ---
        this.app.get('/api/config', (req, res) => {
            res.json(db.getAllConfig());
        });

        this.app.put('/api/config', (req, res) => {
            const { key, value } = req.body;
            if (!key || value === undefined) {
                return res.status(400).json({ error: 'Key and value required' });
            }
            // Validate key is a known config key
            const allowedPrefixes = ['permissions.', 'llm.', 'voice.', 'proactive.', 'ui.', 'email.', 'restricted_paths', 'allowed_paths'];
            if (!allowedPrefixes.some(p => key.startsWith(p))) {
                return res.status(400).json({ error: 'Invalid config key' });
            }
            db.setConfig(key, value);
            db.logActivity('config_change', `${key} updated`, 'admin');
            res.json({ success: true });
        });

        this.app.put('/api/config/batch', (req, res) => {
            const { updates } = req.body;
            if (!Array.isArray(updates)) return res.status(400).json({ error: 'Updates array required' });
            for (const { key, value } of updates) {
                if (key && value !== undefined) {
                    db.setConfig(key, value);
                }
            }
            db.logActivity('config_batch', `${updates.length} settings updated`, 'admin');
            res.json({ success: true });
        });

        // --- Reminders ---
        this.app.get('/api/reminders', (req, res) => {
            res.json(db.getUpcomingReminders(20));
        });

        this.app.delete('/api/reminders/:id', (req, res) => {
            db.deleteReminder(parseInt(req.params.id));
            res.json({ success: true });
        });

        this.app.post('/api/reminders/:id/snooze', (req, res) => {
            const { minutes = 10 } = req.body;
            const newDue = new Date(Date.now() + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
            db.snoozeReminder(parseInt(req.params.id), newDue);
            res.json({ success: true, newDue });
        });

        // --- Schedules ---
        this.app.get('/api/schedules', (req, res) => {
            const days = parseInt(req.query.days) || 7;
            res.json(db.getUpcomingSchedules(days));
        });

        // --- Goals ---
        this.app.get('/api/goals', (req, res) => {
            res.json(db.getActiveGoals());
        });

        this.app.put('/api/goals/:id', (req, res) => {
            db.updateGoal(parseInt(req.params.id), req.body);
            res.json({ success: true });
        });

        // --- Activity Log ---
        this.app.get('/api/activity', (req, res) => {
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            res.json(db.getRecentActivity(limit));
        });

        // --- LLM Status ---
        this.app.get('/api/llm/status', (req, res) => {
            res.json(llm.getStatus());
        });

        // --- User Profile ---
        this.app.get('/api/profile', (req, res) => {
            res.json(db.getUserProfile());
        });

        // --- Conversation History ---
        this.app.get('/api/history', (req, res) => {
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            res.json(db.getConversationHistory(limit));
        });

        // -- New session --
        this.app.post('/api/session/new', (req, res) => {
            this.agent.newSession();
            res.json({ sessionId: this.agent.sessionId });
        });

        // --- LLM Usage Stats ---
        this.app.get('/api/llm/usage', (req, res) => {
            const days = Math.min(parseInt(req.query.days) || 7, 90);
            res.json(db.getLLMUsage(days));
        });

        // --- Plugins ---
        this.app.get('/api/plugins', (req, res) => {
            res.json(db.getAllPlugins());
        });

        this.app.post('/api/plugins/register', (req, res) => {
            const { name, path: pluginPath, description, manifest } = req.body;
            if (!name || !pluginPath) return res.status(400).json({ error: 'Name and path required' });
            db.registerPlugin(name, pluginPath, description || '', manifest || {});
            res.json({ success: true });
        });

        this.app.delete('/api/plugins/:name', (req, res) => {
            db.removePlugin(req.params.name);
            res.json({ success: true });
        });

        this.app.put('/api/plugins/:name/toggle', (req, res) => {
            const { enabled } = req.body;
            db.setPluginEnabled(req.params.name, enabled);
            res.json({ success: true });
        });

        // --- Shortcuts (Interaction Patterns) ---
        this.app.get('/api/shortcuts', (req, res) => {
            res.json(db.getTopPatterns(50));
        });

        this.app.delete('/api/shortcuts/:id', (req, res) => {
            db.deletePattern(parseInt(req.params.id));
            res.json({ success: true });
        });

        // --- Deferred Actions ---
        this.app.get('/api/deferred-actions', (req, res) => {
            res.json(db.listPendingActions());
        });

        // --- System Health ---
        this.app.get('/api/health/system', (req, res) => {
            try {
                const os = require('os');
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
                const cpus = os.cpus();
                const avgLoad = cpus.reduce((sum, cpu) => {
                    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
                    return sum + ((total - cpu.times.idle) / total * 100);
                }, 0) / cpus.length;

                const { exec: execCmd } = require('child_process');
                execCmd('powershell -command "(Get-PSDrive C).Free"', { timeout: 5000 }, (err, stdout) => {
                    const freeGB = err ? 'N/A' : (parseInt(stdout.trim()) / (1024 ** 3)).toFixed(1) + ' GB free';
                    res.json({
                        disk: freeGB,
                        memory: `${memUsage}% used (${(freeMem / (1024 ** 3)).toFixed(1)} GB free of ${(totalMem / (1024 ** 3)).toFixed(1)} GB)`,
                        cpu: `${avgLoad.toFixed(1)}% average load`,
                        uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
                    });
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // --- Daily Stats ---
        this.app.get('/api/stats/daily', (req, res) => {
            try {
                res.json(db.getDailyStats());
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });
    }

    _setupWebSocket() {
        this.wss.on('connection', (ws) => {
            this.clients.add(ws);

            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data.toString());

                    if (msg.type === 'chat') {
                        const userMessage = security.sanitizeInput(msg.content || '');
                        if (!userMessage) return;

                        await this.agent.process(userMessage, (event) => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify(event));
                            }
                        });
                    } else if (msg.type === 'new_chat') {
                        // Start fresh session — summarizes old one
                        this.agent.newSession();
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'new_session', message: 'New conversation started ✨' }));
                        }
                    } else if (msg.type === 'abort') {
                        this.agent.abort();
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'done', content: 'Response stopped. ✋' }));
                        }
                    } else if (msg.type === 'ping') {
                        ws.send(JSON.stringify({ type: 'pong' }));
                    }
                } catch (e) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'error', content: 'Failed to process message' }));
                    }
                }
            });

            ws.on('close', () => {
                this.clients.delete(ws);
            });

            ws.on('error', () => {
                this.clients.delete(ws);
            });

            // Send welcome
            ws.send(JSON.stringify({ type: 'connected', message: 'FRIDAY is online ✨' }));
        });

        // Heartbeat to detect dead connections
        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (!ws.isAlive) return ws.terminate();
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    // Broadcast to all connected clients (used by scheduler)
    broadcast(event) {
        const data = JSON.stringify(event);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    start() {
        return new Promise((resolve) => {
            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`[Server] FRIDAY backend on http://127.0.0.1:${this.port}`);
                resolve();
            });
        });
    }

    getAgent() {
        return this.agent;
    }

    stop() {
        if (this.wss) this.wss.close();
        if (this.server) this.server.close();
    }
}

module.exports = FridayServer;
