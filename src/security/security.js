// ============================================================
// FRIDAY AI – Security Layer
// Encryption, input sanitization, path validation, rate limiting
// ============================================================

const crypto = require('crypto');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

class Security {
  constructor() {
    this._masterKey = null;
  }

  // Derive a master key from machine-specific entropy
  initMasterKey() {
    const os = require('os');
    const seed = `${os.hostname()}-${os.userInfo().username}-FRIDAY-v1-salt`;
    this._masterKey = crypto.createHash('sha256').update(seed).digest();
  }

  get masterKey() {
    if (!this._masterKey) this.initMasterKey();
    return this._masterKey;
  }

  // AES-256-GCM encryption
  encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
  }

  // AES-256-GCM decryption
  decrypt(ciphertext) {
    try {
      const [ivHex, tagHex, encrypted] = ciphertext.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey, iv);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (e) {
      return null;
    }
  }

  // Sanitize user input to prevent injection
  sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    // Remove null bytes
    input = input.replace(/\0/g, '');
    // Limit length to prevent abuse
    if (input.length > 50000) input = input.substring(0, 50000);
    return input.trim();
  }

  // Validate and resolve path, preventing traversal attacks
  validatePath(requestedPath, allowedRoots, restrictedPaths = []) {
    const resolved = path.resolve(requestedPath);

    // Check against restricted paths
    for (const restricted of restrictedPaths) {
      const resolvedRestricted = path.resolve(restricted);
      if (resolved.startsWith(resolvedRestricted)) {
        return { allowed: false, reason: `Path is in restricted zone: ${restricted}` };
      }
    }

    // Check against allowed roots
    if (allowedRoots.length > 0) {
      const inAllowed = allowedRoots.some(root => {
        const resolvedRoot = path.resolve(root);
        return resolved.startsWith(resolvedRoot);
      });
      if (!inAllowed) {
        return { allowed: false, reason: 'Path is outside allowed directories' };
      }
    }

    // Prevent accessing sensitive system paths
    const sensitivePatterns = [
      /\\Windows\\System32/i,
      /\\Windows\\SysWOW64/i,
      /\\Program Files.*\\Windows/i,
      /\\AppData\\.*\\Microsoft\\Credentials/i,
      /\\AppData\\.*\\Microsoft\\Vault/i,
      /\.ssh/i,
      /\.gnupg/i,
      /\.aws/i,
      /\.env/i,
      /\.gitconfig/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(resolved)) {
        return { allowed: false, reason: 'Path matches a sensitive system location' };
      }
    }

    return { allowed: true, resolvedPath: resolved };
  }

  // Validate command execution (prevent shell injection)
  validateCommand(command) {
    const dangerous = [
      /rm\s+-rf/i, /del\s+\/f/i, /format\s+/i,
      /shutdown/i, /taskkill/i,
      /reg\s+delete/i, /reg\s+add/i,
      /net\s+user/i, /net\s+localgroup/i,
      /powershell.*-enc/i, /powershell.*downloadstring/i,
      /curl.*\|.*sh/i, /wget.*\|.*sh/i,
      /certutil.*-urlcache/i,
      /bitsadmin/i,
    ];

    for (const pattern of dangerous) {
      if (pattern.test(command)) {
        return { safe: false, reason: `Command matches dangerous pattern: ${pattern}` };
      }
    }
    return { safe: true };
  }

  // Generate secure session token
  generateToken() {
    return crypto.randomBytes(48).toString('hex');
  }

  // Hash data with SHA-256
  hash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  // Content Security Policy headers
  getCSPHeaders() {
    return {
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "connect-src 'self' ws://localhost:* http://localhost:* https://openrouter.ai https://api.groq.com",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    };
  }
}

module.exports = new Security();
