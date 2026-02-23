// ============================================================
// FRIDAY AI – Dynamic LLM Provider
// Supports OpenRouter + Groq with automatic failover
// ============================================================

const fetch = require('node-fetch');
const db = require('../memory/database');

const PROVIDERS = {
    openrouter: {
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        keyConfig: 'llm.openrouter_key',
        modelConfig: 'llm.openrouter_model',
        headers: (key) => ({
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://friday-ai.local',
            'X-Title': 'FRIDAY AI Assistant',
        }),
    },
    groq: {
        name: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
        keyConfig: 'llm.groq_key',
        modelConfig: 'llm.groq_model',
        headers: (key) => ({
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
        }),
    },
};

class LLMProvider {
    constructor() {
        this.lastUsedProvider = null;
        this.retryCount = 0;
        this.maxRetries = 2;
    }

    _getProviderOrder() {
        const primary = db.getConfig('llm.primary_provider') || 'groq';
        const secondary = primary === 'groq' ? 'openrouter' : 'groq';
        return [primary, secondary];
    }

    _buildToolsPayload(tools) {
        if (!tools || tools.length === 0) return undefined;
        return tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
            },
        }));
    }

    async chat(messages, tools = [], options = {}) {
        const providerOrder = this._getProviderOrder();
        let lastError = null;

        for (const providerKey of providerOrder) {
            const provider = PROVIDERS[providerKey];
            const apiKey = db.getRawConfig(provider.keyConfig);

            if (!apiKey) {
                lastError = `${provider.name}: No API key configured`;
                continue;
            }

            try {
                const result = await this._callProvider(provider, apiKey, messages, tools, options);
                this.lastUsedProvider = providerKey;
                this.retryCount = 0;
                return result;
            } catch (err) {
                // If user aborted, don't fallback — propagate immediately
                if (err.name === 'AbortError') throw err;
                lastError = `${provider.name}: ${err.message}`;
                db.logActivity('llm_error', `${provider.name} failed: ${err.message}`, 'llm', false);
                continue;
            }
        }

        throw new Error(`All LLM providers failed. Last error: ${lastError}`);
    }

    async _callProvider(provider, apiKey, messages, tools, options) {
        const model = db.getConfig(provider.modelConfig);
        const body = {
            model: model,
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
            stream: false,
        };

        const toolsPayload = this._buildToolsPayload(tools);
        if (toolsPayload) {
            body.tools = toolsPayload;
            body.tool_choice = options.toolChoice || 'auto';
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for faster fallback

        // Link external abort signal if provided
        if (options.signal) {
            if (options.signal.aborted) { clearTimeout(timeout); throw new DOMException('Aborted', 'AbortError'); }
            options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            const response = await fetch(provider.baseUrl, {
                method: 'POST',
                headers: provider.headers(apiKey),
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorBody.substring(0, 200)}`);
            }

            const data = await response.json();

            if (!data.choices || data.choices.length === 0) {
                throw new Error('No choices returned from API');
            }

            const choice = data.choices[0];
            const result = {
                content: choice.message?.content || '',
                toolCalls: choice.message?.tool_calls || [],
                finishReason: choice.finish_reason,
                provider: provider.name,
                model: model,
                usage: data.usage || {},
            };

            // Track usage
            try { db.recordLLMUsage(provider.name, model, data.usage || {}); } catch { }

            return result;
        } finally {
            clearTimeout(timeout);
        }
    }

    async chatStream(messages, onChunk, tools = [], options = {}) {
        const providerOrder = this._getProviderOrder();
        let lastError = null;

        for (const providerKey of providerOrder) {
            const provider = PROVIDERS[providerKey];
            const apiKey = db.getRawConfig(provider.keyConfig);
            if (!apiKey) continue;

            try {
                await this._streamProvider(provider, apiKey, messages, onChunk, tools, options);
                this.lastUsedProvider = providerKey;
                return;
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                lastError = `${provider.name}: ${err.message}`;
                continue;
            }
        }

        throw new Error(`All LLM providers failed for streaming. Last error: ${lastError}`);
    }

    async _streamProvider(provider, apiKey, messages, onChunk, tools, options) {
        const model = db.getConfig(provider.modelConfig);
        const body = {
            model: model,
            messages: messages,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
            stream: true,
        };

        const toolsPayload = this._buildToolsPayload(tools);
        if (toolsPayload) {
            body.tools = toolsPayload;
            body.tool_choice = options.toolChoice || 'auto';
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        // Link external abort signal
        if (options.signal) {
            if (options.signal.aborted) { clearTimeout(timeout); throw new DOMException('Aborted', 'AbortError'); }
            options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }

        try {
            const response = await fetch(provider.baseUrl, {
                method: 'POST',
                headers: provider.headers(apiKey),
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorBody.substring(0, 200)}`);
            }

            const reader = response.body;
            let buffer = '';
            let fullContent = '';
            let toolCalls = [];

            return new Promise((resolve, reject) => {
                reader.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6).trim();
                            if (data === '[DONE]') {
                                onChunk({ done: true, content: fullContent, toolCalls });
                                resolve({ content: fullContent, toolCalls, provider: provider.name });
                                return;
                            }
                            try {
                                const parsed = JSON.parse(data);
                                const delta = parsed.choices?.[0]?.delta;
                                if (delta?.content) {
                                    fullContent += delta.content;
                                    onChunk({ done: false, chunk: delta.content, content: fullContent });
                                }
                                if (delta?.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        if (tc.index !== undefined) {
                                            if (!toolCalls[tc.index]) {
                                                toolCalls[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
                                            }
                                            if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                                            if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                                        }
                                    }
                                }
                            } catch (e) { /* skip malformed SSE */ }
                        }
                    }
                });

                reader.on('end', () => {
                    onChunk({ done: true, content: fullContent, toolCalls });
                    resolve({ content: fullContent, toolCalls, provider: provider.name });
                });

                reader.on('error', reject);
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    getStatus() {
        const providerOrder = this._getProviderOrder();
        return {
            primary: providerOrder[0],
            secondary: providerOrder[1],
            lastUsed: this.lastUsedProvider,
            openrouterConfigured: !!db.getRawConfig('llm.openrouter_key'),
            groqConfigured: !!db.getRawConfig('llm.groq_key'),
        };
    }
}

module.exports = new LLMProvider();
