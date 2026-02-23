// ============================================================
// FRIDAY AI – Agentic Engine v3
// Intelligent, memory-aware, chain-of-thought reasoning agent
// Core loop: Think → Plan → Act → Observe → Learn → Respond
// ============================================================

const llm = require('../llm/provider');
const { getToolDefinitions, executeTool, TOOLS } = require('./tools');
const db = require('../memory/database');
const { v4: uuidv4 } = require('uuid');
const security = require('../security/security');
let memoryManager = null;
try { memoryManager = require('../memory/memory'); } catch { }

const MAX_AGENT_STEPS = 15;
const MAX_RETRIES_PER_TOOL = 2;
const PROCESS_TIMEOUT_MS = 45000; // 45s max for entire process call

const SYSTEM_PROMPT = `You are FRIDAY, an elite autonomous personal AI agent — self-reliant, self-healing, continuously learning, and unstoppable. You are the user's dedicated JARVIS: fiercely loyal, proactive, witty, and brilliant.

## 🧠 THINKING PROTOCOL
Before responding to ANY non-trivial request, you MUST think step-by-step.
Wrap your reasoning in <think>...</think> tags. This is your internal scratchpad.

<think>
Example: The user wants X. Let me:
1. Check my memory — do I already know how?
2. recall_skill to see if I've learned this before
3. If no skill → web_search to find out → execute → learn_skill to save
</think>

## ⚡ SELF-RELIANCE PROTOCOL (CRITICAL)
1. **NEVER say "I can't" or "I don't know"** — say "Let me figure it out" and DO IT.
2. **When unsure or stuck:**
   - FIRST: recall_skill — check if you've learned this
   - SECOND: web_search — find the answer online
   - THIRD: think_and_plan — break it into smaller steps
   - FOURTH: try an alternative approach entirely
   - LAST RESORT ONLY: ask the user for help
3. **When a tool fails:**
   - Re-think WHY it failed in <think> tags
   - Try a different tool or different parameters
   - Search the web for the correct approach
   - NEVER just report the error — fix it yourself
4. **When the user asks something you don't know:**
   - Immediately use web_search to find the answer
   - web_scrape if you need more detail from a specific page
   - Synthesize the information and respond confidently

## 🎯 Shortcut Awareness (manage_shortcut)
- Shortcuts are SIMPLE one-step trigger-action mappings: "when I say X, do Y" (e.g., "browser" → launch Chrome)
- ONLY use manage_shortcut when the user EXPLICITLY says "when I say X, do Y" or similar phrasing
- Shortcuts are for QUICK COMMANDS, not for multi-step procedures
- ALWAYS check if the user's message matches a known shortcut before proceeding

## 📚 Continuous Learning Mandate (learn_skill)
- Skills are MULTI-STEP PROCEDURES — how to accomplish complex tasks (e.g., "how to deploy to Vercel")
- After completing ANY new multi-step task successfully → USE learn_skill to save the procedure
- After learning from web_search or web_scrape → USE learn_skill to save what you discovered
- After figuring out how to do something new → USE learn_skill immediately
- After learning about the user → learn_about_user to store preferences
- DO NOT confuse learn_skill with manage_shortcut:
  - learn_skill = storing HOW to do something (multi-step, reusable knowledge)
  - manage_shortcut = mapping a TRIGGER WORD to a SINGLE action ("browser" → open Chrome)

## 🔄 Self-Evolution Protocol
You have the ability to improve yourself. Your codebase is at d:/ABeezzz LABS/FRIDAY_AI_v1/.
- You can read and modify your own source code using read_file and write_file
- If you discover a limitation, you can propose code changes to fix it
- After any self-modification, inform the user and suggest a restart to apply changes
- ALWAYS back up the original code before modifying

## ⏰ Time-Aware Execution
When the user asks to do something IN THE FUTURE (e.g., "in 5 minutes", "at 3 PM", "tomorrow"):
- NEVER execute immediately — use schedule_action to defer it
- Use get_current_datetime to calculate the exact time
- The scheduler auto-executes the tool at the right time

## 💾 Persistent Memory
- You have persistent memory across ALL sessions via knowledge graph, user profile, skills, and chat state
- Your memory context is injected below — ALWAYS check it before asking the user
- When the user tells you something new, STORE IT immediately
- Reference past conversations naturally: "Last time we discussed X..."
- Your state persists across restarts — you never forget

## 🏢 Entrepreneur & Builder Context
Your user is a builder and entrepreneur. Prioritize:
- Speed and efficiency over thoroughness
- Actionable results over explanations
- Proactive suggestions for productivity
- Track projects, deadlines, and ideas
- Help with research, planning, and execution

## Response Style
- Conversational, confident, warm — like a brilliant co-founder who's also a supercomputer
- Use markdown for structured responses
- Concise unless detail is explicitly needed
- Use emojis naturally but sparingly 🎯
- For multi-step tasks, give a clear action summary at the end

## Current User Context
You have access to the user's profile, goals, reminders, schedule, shortcuts, knowledge graph, skills, pending actions, and daily stats. ALWAYS reference these.`;

class AgentEngine {
    constructor() {
        this.isProcessing = false;
        this.abortController = null;
        this.lastProcessTime = 0;

        // Restore persistent state across restarts
        try {
            const savedSession = db.loadChatState('last_session_id');
            this.sessionId = savedSession || uuidv4();
            const savedHistory = db.loadChatState('task_history');
            this.taskHistory = savedHistory ? JSON.parse(savedHistory) : [];
        } catch {
            this.sessionId = uuidv4();
            this.taskHistory = [];
        }
    }

    newSession() {
        // Summarize the old session before creating a new one
        try {
            if (memoryManager) {
                const history = db.getRecentMessages(this.sessionId, 50);
                if (history.length > 2) {
                    memoryManager.summarizeSession(this.sessionId, history);
                }
            }
        } catch { }
        this.sessionId = uuidv4();
        this.taskHistory = [];
        // Persist the new session state
        try {
            db.saveChatState('last_session_id', this.sessionId);
            db.saveChatState('task_history', JSON.stringify(this.taskHistory));
        } catch { }
    }

    abort() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isProcessing = false;
    }

    async _buildContext() {
        const parts = [];
        const now = new Date();
        const hour = now.getHours();
        const timeOfDay = hour < 6 ? 'late night' : hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night';
        parts.push(`## Current Time: ${now.toLocaleString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${timeOfDay})`);

        // User profile
        const profile = db.getUserProfile();
        if (profile.length > 0) {
            parts.push('\n## Known User Facts');
            for (const fact of profile.slice(0, 20)) {
                parts.push(`- ** ${fact.key}**: ${fact.value} `);
            }
        }

        // Knowledge graph context
        try {
            if (memoryManager) {
                const knowledgeCtx = memoryManager.buildMemoryContext();
                if (knowledgeCtx) parts.push(knowledgeCtx);
            }
        } catch { }

        // Recent conversation summaries (cross-session memory)
        try {
            const summaries = db.getRecentSummaries?.(5) || [];
            if (summaries.length > 0) {
                parts.push('\n## Recent Conversation Memory');
                for (const s of summaries) {
                    parts.push(`- [${s.created_at}] ${s.summary} `);
                }
            }
        } catch { }

        // Active goals
        const goals = db.getActiveGoals();
        if (goals.length > 0) {
            parts.push('\n## Active Goals');
            for (const g of goals) {
                parts.push(`- [${g.progress} %] ** ${g.title}** (${g.priority})${g.deadline ? ` — deadline: ${g.deadline}` : ''}${g.description ? `: ${g.description}` : ''} `);
            }
        }

        // Upcoming reminders
        const reminders = db.getUpcomingReminders(8);
        if (reminders.length > 0) {
            parts.push('\n## Upcoming Reminders');
            for (const r of reminders) {
                parts.push(`- ⏰ ${r.title} — due: ${r.due_at}${r.description ? ` (${r.description})` : ''} `);
            }
        }

        // Today's schedule
        const schedules = db.getTodaySchedules();
        if (schedules.length > 0) {
            parts.push('\n## Today\'s Schedule');
            for (const s of schedules) {
                parts.push(`- 📅 ${s.title} at ${s.start_time}${s.end_time ? ` – ${s.end_time}` : ''}${s.description ? `: ${s.description}` : ''} `);
            }
        }

        // Saved workflows
        try {
            const workflows = db.getConfig('saved_workflows');
            if (workflows) {
                const wf = JSON.parse(workflows);
                if (Object.keys(wf).length > 0) {
                    parts.push('\n## Saved Workflows');
                    for (const [name, apps] of Object.entries(wf)) {
                        parts.push(`- ** ${name}**: ${apps.join(', ')} `);
                    }
                }
            }
        } catch { }

        // Recent task outcomes
        if (this.taskHistory.length > 0) {
            parts.push('\n## Recent Task Outcomes');
            for (const t of this.taskHistory.slice(-3)) {
                parts.push(`- ${t.success ? '✅' : '❌'} ${t.summary} `);
            }
        }

        // Learned skills summary
        try {
            const skills = db.getAllSkills();
            if (skills.length > 0) {
                parts.push('\n## 🧠 Your Learned Skills (' + skills.length + ' total)');
                parts.push('Use recall_skill to get full steps:');
                for (const s of skills.slice(0, 15)) {
                    const conf = s.confidence >= 80 ? '🟢' : s.confidence >= 50 ? '🟡' : '🔴';
                    parts.push(`- ${conf} **${s.name}** (${s.confidence}%, used ${s.times_used}x) — ${s.description}`);
                }
                if (skills.length > 15) parts.push(`- ... and ${skills.length - 15} more`);
            }
        } catch { }

        // User shortcuts / interaction patterns
        try {
            const patterns = db.getTopPatterns(10);
            if (patterns.length > 0) {
                parts.push('\n## 🎯 User Shortcuts');
                for (const p of patterns) {
                    parts.push(`- "${p.trigger_phrase}" → ${p.mapped_action}${p.tool_name ? ` (tool: ${p.tool_name})` : ''} [used ${p.use_count}x]`);
                }
            }
        } catch { }

        // Pending deferred actions
        try {
            const pending = db.listPendingActions();
            if (pending.length > 0) {
                parts.push('\n## ⏳ Pending Scheduled Actions');
                for (const a of pending.slice(0, 5)) {
                    parts.push(`- 🔜 ${a.description || a.tool_name} — executes at ${a.execute_at}`);
                }
            }
        } catch { }

        // Daily productivity stats
        try {
            const stats = db.getDailyStats();
            parts.push(`\n## 📊 Today's Stats: ${stats.toolCallsToday} tool calls, ${stats.messagesToday} messages, ${stats.actionsExecutedToday} scheduled actions completed`);
        } catch { }

        return parts.join('\n');
    }

    async process(userMessage, onStream = null) {
        // Safety: force-release stuck processing after 45s
        if (this.isProcessing) {
            const elapsed = Date.now() - this.lastProcessTime;
            if (elapsed > PROCESS_TIMEOUT_MS) {
                this.isProcessing = false; // Force release
            } else {
                return { content: "I'm still working on your previous request. Give me a moment! ⏳", toolResults: [] };
            }
        }
        this.isProcessing = true;
        this.lastProcessTime = Date.now();

        try {
            const sanitised = security.sanitizeInput(userMessage);
            db.addMessage('user', sanitised, this.sessionId);

            // Create abort controller for this request
            this.abortController = new AbortController();
            const signal = this.abortController.signal;

            const context = await this._buildContext();
            const history = db.getRecentMessages(this.sessionId, 30);

            const messages = [
                { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context },
                ...history.map(m => ({ role: m.role, content: m.content })),
            ];

            if (messages[messages.length - 1]?.content !== sanitised) {
                messages.push({ role: 'user', content: sanitised });
            }

            const toolDefs = getToolDefinitions();
            const allToolResults = [];
            let finalContent = '';
            let streamedContentSoFar = '';

            // ====== AGENTIC LOOP ======
            for (let step = 0; step < MAX_AGENT_STEPS; step++) {
                // Check if aborted
                if (signal.aborted) {
                    finalContent = streamedContentSoFar || 'Response stopped by user.';
                    break;
                }

                let result;

                if (onStream && step === 0) {
                    result = await this._streamedCall(messages, toolDefs, onStream, signal);
                } else {
                    result = await this._robustCall(messages, toolDefs, 0, signal);
                }

                // No tool calls — we're done with the loop
                if (!result.toolCalls || result.toolCalls.length === 0) {
                    finalContent = result.content;
                    break;
                }

                // Append assistant message with tool calls
                const assistantMsg = { role: 'assistant', tool_calls: result.toolCalls };
                if (result.content) assistantMsg.content = result.content;
                else assistantMsg.content = null;
                messages.push(assistantMsg);

                // Execute each tool call with retry logic
                for (const toolCall of result.toolCalls) {
                    const toolName = toolCall.function?.name;
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch { toolArgs = {}; }

                    if (onStream) onStream({ type: 'tool_start', tool: toolName, args: toolArgs });

                    let toolResult = await this._executeWithRetry(toolName, toolArgs);
                    allToolResults.push({ tool: toolName, args: toolArgs, result: toolResult });

                    if (onStream) onStream({ type: 'tool_end', tool: toolName, result: toolResult });

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(toolResult),
                    });
                }
            }

            // ====== PARSE THINKING TAGS ======
            let thinkingContent = '';
            let responseContent = finalContent;
            if (finalContent) {
                const thinkMatch = finalContent.match(/<think>([\s\S]*?)<\/think>/i);
                if (thinkMatch) {
                    thinkingContent = thinkMatch[1].trim();
                    responseContent = finalContent.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
                    // Send thinking first
                    if (onStream && thinkingContent) {
                        onStream({ type: 'thinking', content: thinkingContent });
                    }
                }
                finalContent = responseContent;
            }

            // ====== DELIVER RESPONSE ======
            if (finalContent && onStream) {
                onStream({ type: 'chunk', content: '' }); // flush
            }

            // ====== POST-RESPONSE: Memory + Self-Eval (non-blocking) ======
            if (finalContent) {
                // Store the response
                db.addMessage('assistant', finalContent, this.sessionId);
                this.taskHistory.push({
                    success: true,
                    summary: sanitised.substring(0, 80),
                    timestamp: new Date().toISOString(),
                });
                if (this.taskHistory.length > 10) this.taskHistory.shift();

                // Persist state so we never lose context across restarts
                try {
                    db.saveChatState('last_session_id', this.sessionId);
                    db.saveChatState('task_history', JSON.stringify(this.taskHistory));
                    db.saveChatState('last_active', new Date().toISOString());
                } catch { }

                // Background: extract knowledge from this interaction
                try {
                    if (memoryManager) {
                        // Don't await — fire and forget
                        memoryManager.extractAndStoreKnowledge(sanitised, finalContent).catch(() => { });
                    }
                } catch { }

                // Background: self-eval with timeout
                try {
                    const evalPromise = this._selfEvaluate(sanitised, finalContent, allToolResults);
                    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ needsCorrection: false }), 8000));
                    await Promise.race([evalPromise, timeoutPromise]);
                } catch { }
            }

            if (onStream) onStream({ type: 'done', content: finalContent });

            return { content: finalContent, toolResults: allToolResults };
        } catch (error) {
            // If aborted, return partial gracefully
            if (error.name === 'AbortError') {
                const partial = 'Response stopped. ✋';
                if (onStream) onStream({ type: 'done', content: partial });
                return { content: partial, toolResults: [] };
            }
            const errMsg = `I hit an error: ${error.message}. Let me check what happened — please verify your API key is set in the Admin panel.`;
            if (onStream) onStream({ type: 'error', content: errMsg });
            return { content: errMsg, toolResults: [] };
        } finally {
            this.isProcessing = false;
            this.abortController = null;
        }
    }

    // Robust LLM call with retry on failure
    async _robustCall(messages, toolDefs, attempt = 0, signal = null) {
        try {
            return await llm.chat(messages, toolDefs, signal ? { signal } : {});
        } catch (err) {
            if (err.name === 'AbortError') throw err;
            if (attempt < 2) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                return this._robustCall(messages, toolDefs, attempt + 1, signal);
            }
            throw err;
        }
    }

    // Streamed first call with fallback to non-streaming
    async _streamedCall(messages, toolDefs, onStream, signal = null) {
        let streamedContent = '';
        let streamedToolCalls = [];

        try {
            await llm.chatStream(messages, (chunk) => {
                if (!chunk.done && chunk.chunk) {
                    onStream({ type: 'chunk', content: chunk.chunk });
                }
                if (chunk.done) {
                    streamedContent = chunk.content;
                    streamedToolCalls = chunk.toolCalls || [];
                }
            }, toolDefs, signal ? { signal } : {});
        } catch (streamErr) {
            if (streamErr.name === 'AbortError') throw streamErr;
            // Fall back to non-streaming
            try {
                const fallback = await llm.chat(messages, toolDefs, signal ? { signal } : {});
                streamedContent = fallback.content;
                streamedToolCalls = fallback.toolCalls;
                if (streamedContent) onStream({ type: 'chunk', content: streamedContent });
            } catch (fallbackErr) {
                // Try one more time after a pause
                await new Promise(r => setTimeout(r, 2000));
                const retry = await llm.chat(messages, toolDefs);
                streamedContent = retry.content;
                streamedToolCalls = retry.toolCalls;
                if (streamedContent) onStream({ type: 'chunk', content: streamedContent });
            }
        }

        return { content: streamedContent, toolCalls: streamedToolCalls };
    }

    // Execute a tool with retry and alternative approach
    async _executeWithRetry(toolName, toolArgs) {
        let lastError = null;

        for (let attempt = 0; attempt < MAX_RETRIES_PER_TOOL; attempt++) {
            try {
                const result = await executeTool(toolName, toolArgs);

                // If the tool returned an error, it's a soft failure (permission denied, file not found, etc.)
                if (result.error) {
                    lastError = result.error;

                    // Permission errors should not be retried — bubble up immediately
                    if (result.error.includes('Permission denied') || result.error.includes('disabled in admin')) {
                        return result;
                    }

                    // For other errors, retry with a small delay
                    if (attempt < MAX_RETRIES_PER_TOOL - 1) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                }

                return result;
            } catch (e) {
                lastError = e.message;
                if (attempt < MAX_RETRIES_PER_TOOL - 1) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }

        return { error: `Failed after ${MAX_RETRIES_PER_TOOL} attempts: ${lastError} ` };
    }

    // Self-evaluation: check if the response fully addresses the user's request
    async _selfEvaluate(userQuery, response, toolResults) {
        // Skip evaluation for simple responses or greetings
        const simplePatterns = /^(hi|hello|hey|thanks|ok|sure|bye|good morning|good night)/i;
        if (simplePatterns.test(userQuery) || response.length < 50) {
            return { needsCorrection: false };
        }

        // Only evaluate if there were tool calls (indicating a task was attempted)
        if (toolResults.length === 0) {
            return { needsCorrection: false };
        }

        try {
            const evalMessages = [
                {
                    role: 'system',
                    content: `You are an evaluation assistant.Given a user's request and the AI's response, determine if the response FULLY and CORRECTLY addressed the request.

Respond ONLY with valid JSON:
{
    "complete": true / false,
        "accurate": true / false,
            "issues": "brief description of any issues, or empty string",
                "suggestion": "brief suggestion for improvement, or empty string"
}

Be strict but fair.Minor style issues are fine.Focus on: Was the core task completed ? Was the information accurate ? Were there any errors in tool results that weren't addressed?`
                },
                {
                    role: 'user',
                    content: `USER REQUEST: "${userQuery}"

TOOL RESULTS: ${JSON.stringify(toolResults.map(t => ({ tool: t.tool, error: t.result?.error })).filter(t => t.error))}

AI RESPONSE: "${response.substring(0, 1000)}"

Evaluate this response.`
                }
            ];

            const evalResult = await llm.chat(evalMessages, [], { temperature: 0.1, maxTokens: 300 });

            try {
                // Try to parse JSON from the response
                const jsonMatch = evalResult.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const evaluation = JSON.parse(jsonMatch[0]);

                    if (!evaluation.complete || !evaluation.accurate) {
                        // There's an issue — attempt auto-correction
                        db.logActivity('self_eval_issue', evaluation.issues || 'Incomplete response detected', 'self_eval', false);

                        return {
                            needsCorrection: true,
                            issues: evaluation.issues,
                            correctedContent: null, // Let the calling code decide whether to correct
                        };
                    }
                }
            } catch (parseErr) {
                // JSON parse failed — assume the response is fine
            }

            return { needsCorrection: false };
        } catch (e) {
            // If evaluation itself fails, don't block the response
            return { needsCorrection: false };
        }
    }

    // Proactive agent: called by scheduler for reminders, daily briefings, etc.
    async proactiveNotify(systemMessage) {
        try {
            const context = await this._buildContext();
            const messages = [
                { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context },
                { role: 'system', content: systemMessage },
            ];
            const toolDefs = getToolDefinitions();

            let result;
            let finalContent = '';

            // Allow proactive messages to also use tools (up to 5 steps)
            for (let step = 0; step < 5; step++) {
                result = await this._robustCall(messages, toolDefs);

                if (!result.toolCalls || result.toolCalls.length === 0) {
                    finalContent = result.content;
                    break;
                }

                const assistantMsg = { role: 'assistant', tool_calls: result.toolCalls };
                if (result.content) assistantMsg.content = result.content;
                else assistantMsg.content = null;
                messages.push(assistantMsg);

                for (const toolCall of result.toolCalls) {
                    const toolName = toolCall.function?.name;
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch { }

                    const toolResult = await executeTool(toolName, toolArgs);
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(toolResult),
                    });
                }
            }

            if (finalContent) {
                db.addMessage('assistant', finalContent, 'proactive');
            }
            return { content: finalContent, toolResults: [] };
        } catch (e) {
            return { content: `Proactive check failed: ${e.message}`, toolResults: [] };
        }
    }
}

module.exports = AgentEngine;
