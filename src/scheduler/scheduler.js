// ============================================================
// FRIDAY AI – Scheduler & Reminder Engine
// Background job runner: checks reminders, fires notifications
// ============================================================

const cron = require('node-cron');
const db = require('../memory/database');
const { Notification } = require('electron');
const { executeTool } = require('../agent/tools');

class Scheduler {
    constructor(agentEngine, mainWindow) {
        this.agent = agentEngine;
        this.mainWindow = mainWindow;
        this.jobs = [];
        this.running = false;
    }

    start() {
        if (this.running) return;
        this.running = true;

        // Check reminders every 30 seconds
        const reminderJob = cron.schedule('*/30 * * * * *', () => {
            this._checkReminders();
        });
        this.jobs.push(reminderJob);

        // Check deferred actions every 15 seconds
        const actionJob = cron.schedule('*/15 * * * * *', () => {
            this._checkDeferredActions();
        });
        this.jobs.push(actionJob);

        // System health check every 5 minutes
        const healthJob = cron.schedule('*/5 * * * *', () => {
            this._checkSystemHealth();
        });
        this.jobs.push(healthJob);

        // Daily briefing at 8:00 AM
        const briefingJob = cron.schedule('0 8 * * *', () => {
            this._dailyBriefing();
        });
        this.jobs.push(briefingJob);

        // Check goals progress weekly (Sunday 9 PM)
        const goalReview = cron.schedule('0 21 * * 0', () => {
            this._goalReview();
        });
        this.jobs.push(goalReview);

        console.log('[Scheduler] Started — monitoring reminders, deferred actions, system health, briefings, goals');
    }

    stop() {
        for (const job of this.jobs) {
            job.stop();
        }
        this.jobs = [];
        this.running = false;
    }

    async _checkReminders() {
        try {
            const dueReminders = db.getDueReminders();
            for (const reminder of dueReminders) {
                this._fireNotification(reminder.title, reminder.description || 'Reminder is due!');

                // Send to the UI via WebSocket
                if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                    this.mainWindow.webContents.send('friday-notification', {
                        type: 'reminder',
                        id: reminder.id,
                        title: reminder.title,
                        description: reminder.description,
                        due_at: reminder.due_at,
                    });
                }

                // Handle recurrence
                if (reminder.recurrence) {
                    const nextDue = this._calculateNextOccurrence(reminder.due_at, reminder.recurrence);
                    if (nextDue) {
                        db.snoozeReminder(reminder.id, nextDue);
                    } else {
                        db.updateReminderStatus(reminder.id, 'fired');
                    }
                } else {
                    db.updateReminderStatus(reminder.id, 'fired');
                }

                db.logActivity('reminder_fired', `Reminder: ${reminder.title}`, 'scheduler');
            }
        } catch (e) {
            console.error('[Scheduler] Reminder check failed:', e.message);
        }
    }

    async _checkDeferredActions() {
        try {
            const dueActions = db.getDueActions();
            for (const action of dueActions) {
                console.log(`[Scheduler] Executing deferred action: ${action.description} (${action.tool_name})`);

                try {
                    const params = JSON.parse(action.tool_params || '{}');
                    const result = await executeTool(action.tool_name, params);

                    // Mark as executed
                    db.updateActionStatus(action.id, 'executed', JSON.stringify(result));
                    db.logActivity('deferred_action_executed', `${action.description} → ${action.tool_name}`, 'scheduler');

                    // Notify user via desktop notification
                    this._fireNotification(
                        `⚡ Action Executed`,
                        action.description || `Ran ${action.tool_name}`
                    );

                    // Send to UI via WebSocket
                    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                        this.mainWindow.webContents.send('friday-notification', {
                            type: 'deferred_action',
                            id: action.id,
                            tool: action.tool_name,
                            description: action.description,
                            result: result,
                            status: 'executed',
                        });
                    }
                } catch (execErr) {
                    console.error(`[Scheduler] Deferred action failed: ${action.tool_name}`, execErr.message);
                    db.updateActionStatus(action.id, 'failed', execErr.message);
                    db.logActivity('deferred_action_failed', `${action.description}: ${execErr.message}`, 'scheduler', false);

                    this._fireNotification(
                        '❌ Scheduled Action Failed',
                        `${action.description}: ${execErr.message}`
                    );
                }
            }
        } catch (e) {
            console.error('[Scheduler] Deferred action check failed:', e.message);
        }
    }

    _calculateNextOccurrence(currentDue, recurrence) {
        const date = new Date(currentDue);
        switch (recurrence) {
            case 'daily':
                date.setDate(date.getDate() + 1);
                return date.toISOString().slice(0, 19).replace('T', ' ');
            case 'weekly':
                date.setDate(date.getDate() + 7);
                return date.toISOString().slice(0, 19).replace('T', ' ');
            case 'monthly':
                date.setMonth(date.getMonth() + 1);
                return date.toISOString().slice(0, 19).replace('T', ' ');
            default:
                return null;
        }
    }

    async _dailyBriefing() {
        const enabled = db.getConfig('proactive.daily_briefing');
        if (enabled !== '1') return;

        try {
            const result = await this.agent.proactiveNotify(
                'Generate a morning briefing for the user. Include: today\'s schedule, pending reminders, active goals progress, and any suggestions for the day. Be concise and energising.'
            );

            if (result.content && this.mainWindow && !this.mainWindow.isDestroyed()) {
                this._fireNotification('🌅 Good Morning!', 'Your daily briefing is ready.');
                this.mainWindow.webContents.send('friday-proactive', {
                    type: 'daily_briefing',
                    content: result.content,
                });
            }
        } catch (e) {
            console.error('[Scheduler] Daily briefing failed:', e.message);
        }
    }

    async _goalReview() {
        const enabled = db.getConfig('proactive.enabled');
        if (enabled !== '1') return;

        try {
            const result = await this.agent.proactiveNotify(
                'Review the user\'s active goals. Provide a progress summary, highlight any that are falling behind, and suggest actionable steps for the coming week. Be motivating and practical.'
            );

            if (result.content && this.mainWindow && !this.mainWindow.isDestroyed()) {
                this._fireNotification('📊 Weekly Goal Review', 'Check your progress update!');
                this.mainWindow.webContents.send('friday-proactive', {
                    type: 'goal_review',
                    content: result.content,
                });
            }
        } catch (e) {
            console.error('[Scheduler] Goal review failed:', e.message);
        }
    }

    _fireNotification(title, body) {
        try {
            if (Notification.isSupported()) {
                const notif = new Notification({
                    title: `FRIDAY – ${title}`,
                    body: body,
                    icon: null,
                    silent: false,
                });
                notif.on('click', () => {
                    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                        this.mainWindow.show();
                        this.mainWindow.focus();
                    }
                });
                notif.show();
            }
        } catch (e) {
            console.error('[Scheduler] Notification failed:', e.message);
        }
    }

    async _checkSystemHealth() {
        try {
            const os = require('os');
            const { exec: execCmd } = require('child_process');

            // Throttle: only alert once per 30 minutes per issue
            if (!this._healthAlerts) this._healthAlerts = {};
            const now = Date.now();
            const cooldown = 30 * 60 * 1000; // 30 minutes

            // Check memory
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const memUsage = ((totalMem - freeMem) / totalMem * 100).toFixed(1);
            if (parseFloat(memUsage) > 90 && (!this._healthAlerts.memory || now - this._healthAlerts.memory > cooldown)) {
                this._healthAlerts.memory = now;
                this._fireNotification('⚠️ High Memory Usage', `RAM usage is at ${memUsage}%. Consider closing some apps.`);
                db.logActivity('health_alert', `High memory: ${memUsage}%`, 'scheduler');
            }

            // Check disk space (Windows)
            execCmd('powershell -command "(Get-PSDrive C).Free"', { timeout: 5000 }, (err, stdout) => {
                if (err) return;
                const freeBytes = parseInt(stdout.trim());
                const freeGB = (freeBytes / (1024 ** 3)).toFixed(1);
                if (parseFloat(freeGB) < 5 && (!this._healthAlerts.disk || now - this._healthAlerts.disk > cooldown)) {
                    this._healthAlerts.disk = now;
                    this._fireNotification('💾 Low Disk Space', `Only ${freeGB} GB free on C: drive!`);
                    db.logActivity('health_alert', `Low disk: ${freeGB} GB free`, 'scheduler');
                }
            });

            // Check CPU load average
            const cpus = os.cpus();
            const avgLoad = cpus.reduce((sum, cpu) => {
                const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
                return sum + ((total - cpu.times.idle) / total * 100);
            }, 0) / cpus.length;
            if (avgLoad > 90 && (!this._healthAlerts.cpu || now - this._healthAlerts.cpu > cooldown)) {
                this._healthAlerts.cpu = now;
                this._fireNotification('🔥 High CPU Usage', `CPU usage is at ${avgLoad.toFixed(1)}%. System may be sluggish.`);
                db.logActivity('health_alert', `High CPU: ${avgLoad.toFixed(1)}%`, 'scheduler');
            }
        } catch (e) {
            console.error('[Scheduler] Health check failed:', e.message);
        }
    }
}

module.exports = Scheduler;
