# 🤖 FRIDAY AI — Your Autonomous Personal AI Agent

<div align="center">

**An elite, self-healing, continuously learning AI personal assistant — built with Electron, powered by LLMs.**

FRIDAY is your dedicated JARVIS: fiercely loyal, proactive, witty, and brilliant.

</div>

---

## ✨ Features

| Feature | Description |
|---|---|
| 🧠 **Self-Healing Intelligence** | Never says "I can't" — auto-searches, auto-recalls skills, retries with different approaches |
| ⚡ **38 Built-in Tools** | File management, app launching, web search, scheduling, reminders, goals, email, system info |
| 📚 **Skill Learning** | Learns new capabilities and recalls them automatically |
| 🔗 **Knowledge Graph** | Persistent memory across conversations with semantic extraction |
| ⏰ **Scheduling & Reminders** | Full CRUD for schedules, reminders, goals with notifications |
| 💊 **System Health Monitoring** | Proactive disk/CPU/memory monitoring with alerts |
| 🎯 **User Shortcuts** | Learn your language — "when I say X, do Y" |
| 📋 **Smart Clipboard** | Auto-detects clipboard content type and suggests actions |
| 🔄 **Self-Evolution** | Can read and modify its own codebase |
| 💾 **Persistent State** | Session survives restarts — never forgets |
| 🔒 **Security-First** | AES-256-GCM encryption, CSP headers, input sanitization, path validation |

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Git](https://git-scm.com/)

### Installation

```bash
# Clone the repository
git clone https://github.com/freeatom/F.R.I.D.A.Y.git
cd FRIDAY_AI_v1

# Install dependencies
npm install

# Start FRIDAY
npm start
```

### Configuration
1. Launch FRIDAY
2. Click the **⚙️ Settings** button
3. Add your LLM API key (OpenRouter, Groq, etc.)
4. Optionally configure web search (You.com) and email (SMTP)

> **Note**: All API keys are stored **encrypted** in a local database using AES-256-GCM. They never leave your machine.

## 🏛️ Architecture

```
FRIDAY AI
├── main.js              # Electron main process
├── preload.js           # Secure IPC bridge
├── src/
│   ├── agent/
│   │   ├── engine.js    # Core AI agent engine
│   │   └── tools.js     # 38 built-in tools
│   ├── llm/
│   │   └── provider.js  # Multi-provider LLM interface
│   ├── memory/
│   │   ├── database.js  # SQLite database layer
│   │   └── memory.js    # Knowledge graph & memory
│   ├── scheduler/
│   │   └── scheduler.js # Cron-based task scheduler
│   ├── security/
│   │   └── security.js  # Encryption & input validation
│   └── server/
│       └── server.js    # Express + WebSocket server
└── ui/
    ├── index.html       # Main UI
    ├── app.js           # Frontend logic
    ├── styles.css        # Styling
    └── admin.js         # Admin settings panel
```

## 🔐 Security

- **Encryption**: AES-256-GCM for all stored API keys and secrets
- **Master Key**: Derived from machine-specific entropy (not hardcoded)
- **Network**: Localhost-only server, CSP headers, Helmet.js
- **Filesystem**: Path traversal prevention, dangerous command detection
- **Input**: Sanitization on all user inputs

See [SECURITY.md](SECURITY.md) for full details.

