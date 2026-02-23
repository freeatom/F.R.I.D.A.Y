# Security Policy — FRIDAY AI

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:
- **Email**: [your-email@domain.com]
- **Do NOT** create a public GitHub issue for security vulnerabilities

## How Secrets Are Protected

### API Keys & Credentials
- All API keys (LLM providers, web search, SMTP) are stored in a **local SQLite database**
- Keys containing `_key` in their config name are automatically **encrypted using AES-256-GCM**
- The master encryption key is derived from **machine-specific entropy** (hostname + username), meaning the database is useless if copied to another machine
- API keys are **never** hardcoded in source files
- The database file (`*.db`) is excluded from Git via `.gitignore`

### Session Security
- Session tokens are generated using `crypto.randomBytes(48)`
- Content Security Policy (CSP) headers are enforced
- Rate limiting is applied to API endpoints
- Input sanitization prevents injection attacks

### File System Access
- Path traversal prevention with whitelist/blacklist validation
- Sensitive system paths (`.ssh`, `.aws`, `.env`, Windows credentials) are blocked
- Dangerous shell commands are detected and rejected

### Network Security
- CORS is disabled (localhost-only access)
- Helmet.js security headers are applied
- WebSocket connections are authenticated

## Architecture

```
User → Electron App → Express Server (localhost only)
                          ↓
                    SQLite Database (encrypted secrets)
                          ↓
                    LLM Provider APIs (keys from encrypted DB)
```

## Best Practices for Contributors
1. **Never** hardcode API keys, tokens, or passwords
2. **Always** use `db.getConfig()` / `db.setConfig()` for sensitive values
3. **Never** log sensitive data — use `security.sanitizeInput()` for user content
4. **Always** validate file paths with `security.validatePath()`
5. **Always** validate commands with `security.validateCommand()`
