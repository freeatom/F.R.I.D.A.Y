// ============================================================
// FRIDAY AI – Intelligent Memory Manager
// Knowledge graph, session summaries, entity extraction
// Makes FRIDAY remember and learn from every conversation
// ============================================================

const db = require('./database');

// Patterns for extracting knowledge from conversations
const ENTITY_PATTERNS = {
    // Names and people
    person: /(?:my (?:name is|friend|brother|sister|mom|dad|boss|colleague|partner) (?:is )?|I'm |I am )([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g,
    // Projects
    project: /(?:project|app|application|website|repo|codebase|product)\s+(?:called |named )?["']?([A-Za-z][A-Za-z0-9_\- ]{1,40})["']?/gi,
    // Preferences
    preference: /(?:I (?:like|love|prefer|hate|dislike|enjoy|use|always use|usually))\s+(.{3,50}?)(?:\.|,|$)/gi,
    // Tools and tech
    technology: /(?:I (?:use|work with|develop (?:in|with)|code (?:in|with))|using)\s+([A-Za-z][A-Za-z0-9.# +]{1,30})/gi,
    // Locations
    location: /(?:I (?:live|stay|am from|work) (?:in|at|from))\s+([A-Z][a-zA-Z\s,]{2,40})/g,
    // Goals and intentions
    goal: /(?:I (?:want to|need to|plan to|am going to|will|should))\s+(.{5,80}?)(?:\.|,|!|$)/gi,
};

class MemoryManager {
    constructor() {
        this.extractionQueue = [];
        this.isProcessing = false;
    }

    /**
     * Extract entities and facts from a user message + assistant response
     * Called fire-and-forget after each interaction
     */
    async extractAndStoreKnowledge(userMessage, assistantResponse) {
        try {
            // Extract from user message (most valuable)
            this._extractEntities(userMessage, 'user');

            // Extract implicit facts from what was discussed
            this._extractTopics(userMessage + ' ' + assistantResponse);

            // Track conversation topics
            this._trackTopics(userMessage);
        } catch (err) {
            // Never let extraction crash the main flow
        }
    }

    /**
     * Extract named entities from text and store in knowledge graph
     */
    _extractEntities(text, source = 'user') {
        for (const [type, pattern] of Object.entries(ENTITY_PATTERNS)) {
            // Reset regex state
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const value = match[1]?.trim();
                if (!value || value.length < 2) continue;

                const importance = type === 'person' ? 8 : type === 'preference' ? 7 : 5;
                db.addKnowledgeNode(type, value, `Extracted from ${source} message`, { source }, importance);
            }
        }
    }

    /**
     * Extract and track conversation topics
     */
    _trackTopics(text) {
        // Extract key words (simple but effective)
        const words = text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 4);

        // Common stop words to skip
        const stopWords = new Set([
            'about', 'after', 'again', 'being', 'could', 'every', 'first',
            'found', 'great', 'their', 'there', 'these', 'thing', 'think',
            'those', 'under', 'using', 'where', 'which', 'while', 'would',
            'should', 'could', 'please', 'thanks', 'thank', 'really',
            'actually', 'basically', 'something', 'anything', 'everything',
        ]);

        const topics = [...new Set(words)].filter(w => !stopWords.has(w)).slice(0, 5);
        for (const topic of topics) {
            db.addKnowledgeNode('topic', topic, '', {}, 2);
        }
    }

    /**
     * Extract topics from combined user+assistant text
     */
    _extractTopics(text) {
        // Look for explicit "about" references
        const aboutMatch = text.match(/(?:about|regarding|concerning)\s+([^.]{3,40})/gi);
        if (aboutMatch) {
            for (const m of aboutMatch.slice(0, 3)) {
                const topic = m.replace(/^(?:about|regarding|concerning)\s+/i, '').trim();
                if (topic.length > 2) {
                    db.addKnowledgeNode('topic', topic, '', {}, 3);
                }
            }
        }
    }

    /**
     * Build memory context for the system prompt
     * Returns a formatted string with the most relevant knowledge
     */
    buildMemoryContext() {
        const parts = [];

        try {
            // Top knowledge nodes by importance
            const topNodes = db.getTopKnowledgeNodes(15);
            if (topNodes.length > 0) {
                parts.push('\n## 🧠 Knowledge Graph Memory');

                // Group by type
                const byType = {};
                for (const node of topNodes) {
                    if (!byType[node.type]) byType[node.type] = [];
                    byType[node.type].push(node);
                }

                for (const [type, nodes] of Object.entries(byType)) {
                    const label = type.charAt(0).toUpperCase() + type.slice(1) + 's';
                    const items = nodes.map(n => {
                        let line = n.name;
                        if (n.description && n.description.length > 0 && !n.description.startsWith('Extracted')) {
                            line += `: ${n.description}`;
                        }
                        return line;
                    });
                    parts.push(`- **${label}**: ${items.join(', ')}`);
                }
            }
        } catch { }

        return parts.length > 0 ? parts.join('\n') : '';
    }

    /**
     * Summarize a session when it ends  
     * Creates a compressed summary for long-term memory
     */
    summarizeSession(sessionId, messages) {
        try {
            if (!messages || messages.length < 2) return;

            // Build a simple summary from the conversation
            const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
            const assistantMessages = messages.filter(m => m.role === 'assistant').map(m => m.content);

            // Extract key topics from user messages
            const allUserText = userMessages.join(' ');
            const keyTopics = this._extractKeyTopics(allUserText);

            // Build summary
            const topUserMsgs = userMessages.slice(0, 3).map(m => m.substring(0, 60)).join('; ');
            const summary = `User discussed: ${topUserMsgs}. Topics: ${keyTopics.join(', ')}. ${userMessages.length} messages exchanged.`;

            // Determine intent
            const intent = this._classifyIntent(allUserText);

            db.addConversationSummary(
                sessionId,
                summary,
                keyTopics,
                [], // entities — we already extract these in real-time
                intent,
                'completed',
                messages.length
            );
        } catch { }
    }

    /**
     * Extract key topics from text
     */
    _extractKeyTopics(text) {
        const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        const freq = {};
        const stopWords = new Set([
            'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
            'had', 'her', 'was', 'one', 'our', 'out', 'has', 'have', 'this',
            'that', 'with', 'from', 'they', 'been', 'said', 'each', 'make',
            'like', 'just', 'over', 'such', 'take', 'than', 'them', 'very',
            'some', 'what', 'know', 'when', 'who', 'will', 'way', 'about',
            'many', 'then', 'also', 'into', 'your', 'how', 'its', 'let',
            'may', 'much', 'should', 'could', 'would', 'please', 'thanks',
        ]);

        for (const w of words) {
            if (w.length > 3 && !stopWords.has(w)) {
                freq[w] = (freq[w] || 0) + 1;
            }
        }

        return Object.entries(freq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([word]) => word);
    }

    /**
     * Classify the user's intent from their messages
     */
    _classifyIntent(text) {
        const lower = text.toLowerCase();
        if (/(?:fix|bug|error|broken|crash|fail)/.test(lower)) return 'debugging';
        if (/(?:create|build|make|add|implement|develop)/.test(lower)) return 'creation';
        if (/(?:find|search|look|where|locate)/.test(lower)) return 'search';
        if (/(?:explain|what|how|why|tell me)/.test(lower)) return 'learning';
        if (/(?:open|launch|start|run|execute)/.test(lower)) return 'execution';
        if (/(?:remind|schedule|plan|deadline)/.test(lower)) return 'planning';
        return 'general';
    }

    /**
     * Recall knowledge related to a query
     */
    recallRelevant(query) {
        try {
            const nodes = db.searchKnowledgeNodes(query);
            if (nodes.length === 0) return [];

            // For each found node, also get related nodes
            const results = [];
            for (const node of nodes.slice(0, 5)) {
                const related = db.getRelatedNodes(node.id);
                results.push({ ...node, related });
            }
            return results;
        } catch {
            return [];
        }
    }
}

module.exports = new MemoryManager();
