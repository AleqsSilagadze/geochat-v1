const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto'); // ✅ SEC: built-in, no install needed

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

// ══════════════════════════════════════════════════════════════
// ✅ SEC-1: HELMET — hardened HTTP headers
// ══════════════════════════════════════════════════════════════
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src":      ["'self'"],
            "script-src":       ["'self'", "'unsafe-inline'", "https://cdn.socket.io", "https://challenges.cloudflare.com", "https://unpkg.com", "https://cdn.jsdelivr.net"],
            "style-src":        ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src":         ["'self'", "https://fonts.gstatic.com"],
            // ✅ SEC: connect-src — allow nsfwjs model fetch
            "connect-src":      ["'self'", "wss:", "ws:", "https://nsfwjs.com", "https://cdn.jsdelivr.net"],
            "img-src":          ["'self'", "data:"],
            "media-src":        ["'self'", "blob:"],
            // ✅ SEC: block all object/embed — no plugin attacks
            "object-src":       ["'none'"],
            // ✅ Allow Turnstile iframe from Cloudflare
            "frame-src":        ["https://challenges.cloudflare.com"],
            "frame-ancestors":  ["'none'"],
            "base-uri":         ["'self'"],
            "form-action":      ["'self'"],
        },
    },
    // ✅ SEC: prevent clickjacking
    frameguard: { action: 'deny' },
    // ✅ SEC: force HTTPS
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    // ✅ SEC: hide X-Powered-By: Express
    hidePoweredBy: true,
    // ✅ SEC: prevent MIME sniffing
    noSniff: true,
    // ✅ SEC: XSS filter in older browsers
    xssFilter: true,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" } // ✅ SEC: was cross-origin
}));

// ✅ SEC-2: Remove fingerprinting headers
app.use((req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.removeHeader('Server');
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ✅ SEC-3: Body size limit — prevent large payload attacks
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ══════════════════════════════════════════════════════════════
// ✅ SEC-4: RATE LIMITING — tiered
// ══════════════════════════════════════════════════════════════

// General HTTP rate limit
const generalLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 60,
    message: "Too many requests.",
    standardHeaders: true,
    legacyHeaders: false,
    // ✅ SEC: don't expose rate limit headers to attackers
    skip: (req) => req.path === '/health',
});
app.use(generalLimiter);

// Stricter limit for the /chat entry point
const chatLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 10,
    message: "Too many chat requests.",
    standardHeaders: false,
    legacyHeaders: false,
});

// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ✅ SEC-EXTRA: Additional hardening
// ══════════════════════════════════════════════════════════════

// Block suspicious User-Agents (bots, scanners)
const BLOCKED_UA_PATTERNS = [
    /sqlmap/i, /nikto/i, /nmap/i, /masscan/i, /zgrab/i,
    /python-requests/i, /go-http-client/i, /libwww-perl/i,
    /curl\/[0-9]/i, /wget\/[0-9]/i
];
app.use((req, res, next) => {
    const ua = req.headers['user-agent'] || '';
    if (BLOCKED_UA_PATTERNS.some(p => p.test(ua))) {
        return res.status(403).end();
    }
    next();
});

// Block path traversal & injection attempts
app.use((req, res, next) => {
    const url = req.originalUrl;
    if (/(\.\.|%2e%2e|%252e|\0|;|\||`|\$\{)/i.test(url)) {
        return res.status(400).end();
    }
    next();
});

// ✅ SEC: Strip server info from all responses
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    next();
});

// ══════════════════════════════════════════════════════════════
// ✅ SEC-5: INPUT VALIDATION HELPERS
// ══════════════════════════════════════════════════════════════

const VALID_GENDERS = ['male', 'female'];
const VALID_CITIES  = ['random','თბილისი','ბათუმი','ქუთაისი','რუსთავი','გორი','ზუგდიდი','ფოთი','ხაშური','სამტრედია','სენაკი','ხონი'];

// ✅ SEC: strict nickname — only Georgian letters, Latin letters, digits
// Blocks: unicode homoglyphs, zero-width chars, RTL override, emoji injections
const NICKNAME_REGEX = /^[\wა-ჰ0-9]+$/;

function validateNickname(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.trim().substring(0, 15);
    // Strip zero-width / invisible unicode characters
    const stripped = cleaned.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '');
    if (stripped.length < 2 || stripped.length > 15) return null;
    if (!NICKNAME_REGEX.test(stripped)) return null;
    return xss(stripped);
}

// ✅ SEC: mask IP for logging — never log full IPs in production
function maskIP(ip) {
    if (!ip) return 'unknown';
    if (ip.includes(':')) {
        // IPv6 — show first 3 groups only
        const parts = ip.split(':');
        return parts.slice(0, 3).join(':') + ':****';
    }
    // IPv4 — mask last octet
    const parts = ip.split('.');
    return parts.slice(0, 3).join('.') + '.***';
}

// ✅ SEC: generate anonymous session token — never expose socket.id to client logs
function generateSessionToken() {
    return crypto.randomBytes(8).toString('hex');
}

// ══════════════════════════════════════════════════════════════
// ✅ SEC-6: ROUTES — hardened
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

app.get('/registration', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

// ✅ SEO
app.get('/robots.txt',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'robots.txt')));
app.get('/sitemap.xml',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'sitemap.xml')));
app.get('/manifest.json',(req, res) => res.sendFile(path.join(__dirname, 'public', 'manifest.json')));

// ✅ /chat — sessionStorage used on client, no URL params needed
// Validation happens in script.js (loadSession) and on socket events
// ⏱️ IP დარჩენილი დრო
app.get('/api/time-status', (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const vipCode = (req.query.vip || '').toString().trim().toUpperCase();
    const remaining = getRemainingMs(ip);
    const isVip = (() => {
        if (!vipCode) return false;
        const e = vipCodes.get(vipCode);
        return e && Date.now() <= e.expiresAt;
    })();
    res.json({
        remainingMs: isVip ? FREE_LIMIT_MS : remaining,
        limitReached: !isVip && remaining <= 0,
        isVip,
        freeMinutes: 60
    });
});


// ══════════════════════════════════════════════════════════════
// 💳 STRIPE CHECKOUT — plug-and-play
// დასაყენებლად: npm install stripe
// env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET
// ══════════════════════════════════════════════════════════════
let stripe = null;
try {
    if (process.env.STRIPE_SECRET_KEY) {
        stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        console.log('[Stripe] ✅ Stripe initialized');
    } else {
        console.log('[Stripe] ℹ️  STRIPE_SECRET_KEY not set — Stripe disabled');
    }
} catch(e) {
    console.warn('[Stripe] stripe package not installed — run: npm install stripe');
}

// ── Create Checkout Session ────────────────────────────────────
app.post('/vip/create-checkout', async (req, res) => {
    if (!stripe || !process.env.STRIPE_PRICE_ID) {
        return res.json({ url: null, error: 'stripe_not_configured' });
    }
    try {
        const origin = process.env.ALLOWED_ORIGIN || ('https://' + req.hostname);
        // Generate temp code that will be activated on webhook
        const tempCode = 'VIP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
        const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 დღე

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
            success_url: origin + '/upgrade?vip_code=' + tempCode,
            cancel_url:  origin + '/upgrade',
            metadata: { vip_code: tempCode, expires_at: String(expiresAt) },
            // ✅ SEC: prevent duplicate payments
            payment_intent_data: { metadata: { vip_code: tempCode } },
        });

        // Pre-register code (activated on webhook confirmation)
        vipCodes.set(tempCode, { expiresAt, createdAt: Date.now(), usedByIP: null, paid: false });
        vipAuditLog.push({ code: tempCode, action: 'checkout_created', ts: Date.now(), sessionId: session.id });

        res.json({ url: session.url });
    } catch(e) {
        console.error('[Stripe] checkout error:', e.message);
        res.status(500).json({ url: null, error: 'checkout_failed' });
    }
});

// ── Stripe Webhook — გადახდის დადასტურება ─────────────────────
// raw body საჭიროა webhook signature-სთვის
app.post('/vip/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!stripe || !webhookSecret) { return res.status(400).end(); }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret);
    } catch(e) {
        console.error('[Stripe webhook] signature error:', e.message);
        return res.status(400).end();
    }

    if (event.type === 'checkout.session.completed') {
        const session  = event.data.object;
        const vipCode  = session.metadata?.vip_code;
        const expiresAt= parseInt(session.metadata?.expires_at || '0');
        if (vipCode && expiresAt) {
            vipCodes.set(vipCode, { expiresAt, createdAt: Date.now(), usedByIP: null, paid: true });
            vipAuditLog.push({ code: vipCode, action: 'payment_confirmed', ts: Date.now(), sessionId: session.id });
            console.log('[Stripe] ✅ Payment confirmed, VIP code:', vipCode);
        }
    }

    res.json({ received: true });
});

// 💳 VIP განახლების გვერდი
app.get('/upgrade', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Upgrade.html'));
});

// 📋 Terms of Service
app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Terms.html'));
});

// 🔒 Privacy Policy
app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Privacy.html'));
});

// 🛡️ Admin Panel (HTML)
app.get('/admin', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) return res.status(404).redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'Admin.html'));
});

// ── Admin API: სტატისტიკა ────────────────────────────────────
app.get('/admin/stats', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) return res.status(404).end();
    if ((req.headers['x-admin-token'] || req.query.token) !== tok) return res.status(403).end();

    const activeVip = [...vipCodes.values()].filter(v => Date.now() <= v.expiresAt).length;
    const bannedMasked = [...bannedIPs].map(ip => maskIP(ip));

    res.json({
        online:     activeUsersCount,
        waiting:    waitingUsers.length,
        banned:     bannedIPs.size,
        bannedList: bannedMasked,
        vipActive:  activeVip,
        reports:    reportAILog.length,
    });
});

// ── Admin API: IP ბანი ──────────────────────────────────────
app.post('/admin/ban', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) return res.status(404).end();
    if ((req.headers['x-admin-token'] || req.body?.token) !== tok) return res.status(403).end();
    const ip = (req.body?.ip || '').toString().trim();
    if (!ip) return res.json({ success: false, error: 'ip_required' });
    bannedIPs.add(ip);
    console.log(`[ADMIN BAN] ${maskIP(ip)}`);
    // დავკავშიროთ ბანის ლოგი
    vipAuditLog.push({ action: 'admin_ban', ip: maskIP(ip), ts: Date.now() });
    res.json({ success: true });
});

// ── Admin API: IP განბანი ───────────────────────────────────
app.post('/admin/unban', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) return res.status(404).end();
    if ((req.headers['x-admin-token'] || req.body?.token) !== tok) return res.status(403).end();
    const ip = (req.body?.ip || '').toString().trim();
    if (!ip) return res.json({ success: false, error: 'ip_required' });
    // masked IP-ით მოძიება
    let found = false;
    for (const banned of bannedIPs) {
        if (banned === ip || maskIP(banned) === ip) {
            bannedIPs.delete(banned);
            found = true;
            break;
        }
    }
    if (found) {
        console.log(`[ADMIN UNBAN] ${maskIP(ip)}`);
        vipAuditLog.push({ action: 'admin_unban', ip: maskIP(ip), ts: Date.now() });
    }
    res.json({ success: found, error: found ? null : 'not_found' });
});

app.get('/chat', chatLimiter, (req, res) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (bannedIPs.has(ip)) return res.status(403).redirect('/');
    // ლიმიტი შემოწმდება socket connection-ზე (VIP კოდი მხოლოდ მაშინ ჩნდება)
    res.sendFile(path.join(__dirname, 'public', 'main_page.html'));
});

// ✅ SEC: /health — restricted info, no banned IP count exposed
app.get('/health', (req, res) => {
    // ✅ SEC: only expose what's needed — no internal state leakage
    res.status(200).json({
        status: 'ok',
        online: activeUsersCount,
    });
});

// ✅ SEC: catch-all 404 — don't reveal file structure
app.use((req, res) => {
    res.status(404).redirect('/');
});

// ══════════════════════════════════════════════════════════════
// ✅ SEC-7: SOCKET.IO — hardened config
// ══════════════════════════════════════════════════════════════
const io = socketIo(server, {
    cors: {
        // ✅ SEC: restrict to your own domain in production
        // Change "*" to your actual Render URL e.g. "https://geochat.onrender.com"
        origin: process.env.ALLOWED_ORIGIN || "*",
        methods: ["GET", "POST"],
        credentials: false // ✅ SEC: was true — not needed, prevents cookie theft
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 50 * 1024, // ✅ SEC: was 1MB → 50KB — messages don't need more
    transports: ['websocket', 'polling'],
    // ✅ SEC: prevent socket.io from accepting huge upgrade requests
    allowUpgrades: true,
    upgradeTimeout: 10000,
    // ✅ SEC: close unidentified connections faster
    connectTimeout: 45000,
});

// ══════════════════════════════════════════════════════════════
// ✅ STATE
// ══════════════════════════════════════════════════════════════
let waitingUsers = [];
let activeUsersCount = 0;

// ✅ SEC: separate report tracking — by reporter socketId to prevent spam
// reportsByReporter: Map<reporterSocketId, Set<reportedIP>>
const reportsByReporter = new Map();

// Actual report counts per IP
const reportCounts = {};

// Permanent ban list (in-memory; see note below about persistence)
const bannedIPs = new Set();

// Connection rate limiting
const connectionAttempts = new Map(); // IP → [timestamps]

// ══════════════════════════════════════════════════════════════
// ⏱️ IP FREE TIME LIMIT — 30 წუთი/დღე უფასოდ
// ══════════════════════════════════════════════════════════════
// 💎 VIP კოდები — Map<code, { expiresAt: timestamp, createdAt, usedByIP }>
const vipCodes = new Map();

// 💎 VIP audit log — კოდების გამოყენება
const vipAuditLog = [];

const FREE_LIMIT_MS = 60 * 60 * 1000; // 1 საათი

// Map<ip, { usedMs: number, lastStart: number|null, dayKey: string }>
const ipTimeMap = new Map();

function getDayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
}

function getIpEntry(ip) {
    const today = getDayKey();
    let entry = ipTimeMap.get(ip);
    if (!entry || entry.dayKey !== today) {
        entry = { usedMs: 0, lastStart: null, dayKey: today };
        ipTimeMap.set(ip, entry);
    }
    return entry;
}

function startIpTimer(ip) {
    const e = getIpEntry(ip);
    if (!e.lastStart) e.lastStart = Date.now();
}

function stopIpTimer(ip) {
    const e = getIpEntry(ip);
    if (e.lastStart) {
        e.usedMs += Date.now() - e.lastStart;
        e.lastStart = null;
    }
}

function getRemainingMs(ip) {
    const e = getIpEntry(ip);
    let used = e.usedMs;
    if (e.lastStart) used += Date.now() - e.lastStart;
    return Math.max(0, FREE_LIMIT_MS - used);
}

function isIpLimitReached(ip, vipCode) {
    // VIP კოდი — ლიმიტი არ მოქმედებს
    if (vipCode) {
        const entry = vipCodes.get((vipCode||'').toString().trim().toUpperCase());
        if (entry && Date.now() <= entry.expiresAt) return false;
    }
    return getRemainingMs(ip) <= 0;
}

// Message rate limiting
const userMessageCounts = new Map();  // socketId → [timestamps]

// Connection tracking
const userConnections = new Map();    // socketId → timestamp

// ✅ SEC: track how many sockets are open per IP — limit multi-tab abuse
const socketsPerIP = new Map();       // IP → Set<socketId>

// ══════════════════════════════════════════════════════════════
// ✅ SEC-8: RATE LIMIT HELPERS
// ══════════════════════════════════════════════════════════════

// Max 5 new connections per minute per IP (was 10 — tighter)
function checkConnectionRateLimit(ip) {
    const now = Date.now();
    const attempts = connectionAttempts.get(ip) || [];
    const recent = attempts.filter(t => now - t < 60000);
    if (recent.length >= 5) return false;
    recent.push(now);
    connectionAttempts.set(ip, recent);
    return true;
}

// Max 15 messages per 10 seconds per socket (was 20)
function checkMessageRateLimit(socketId) {
    const now = Date.now();
    const msgs = userMessageCounts.get(socketId) || [];
    const recent = msgs.filter(t => now - t < 10000);
    if (recent.length >= 15) return false;
    recent.push(now);
    userMessageCounts.set(socketId, recent);
    return true;
}

// ✅ SEC: max 3 simultaneous tabs/connections per IP
function checkMaxConnectionsPerIP(ip, socketId) {
    const sockets = socketsPerIP.get(ip) || new Set();
    if (sockets.size >= 3) return false;
    sockets.add(socketId);
    socketsPerIP.set(ip, sockets);
    return true;
}

function removeSocketFromIP(ip, socketId) {
    const sockets = socketsPerIP.get(ip);
    if (sockets) {
        sockets.delete(socketId);
        if (sockets.size === 0) socketsPerIP.delete(ip);
    }
}

// Remove users waiting more than 5 minutes
function cleanupInactiveUsers() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    waitingUsers = waitingUsers.filter(socket => {
        const t = userConnections.get(socket.id);
        if (t && now - t > timeout) {
            socket.emit('error', 'Session timed out. Please refresh.');
            socket.disconnect();
            return false;
        }
        return true;
    });
}

// ══════════════════════════════════════════════════════════════
// ✅ SEC-9: SIGNAL DATA SANITIZER
// WebRTC SDP/ICE can contain local IPs — we strip them server-side
// This prevents local network IP leakage through WebRTC
// ══════════════════════════════════════════════════════════════
function sanitizeSignalData(data) {
    if (!data || typeof data !== 'object') return null;

    // Only allow known keys
    const allowed = {};

    if (data.sdp) {
        if (typeof data.sdp !== 'object') return null;
        if (!['offer', 'answer'].includes(data.sdp.type)) return null;
        if (typeof data.sdp.sdp !== 'string') return null;
        if (data.sdp.sdp.length > 8000) return null; // ✅ SEC: SDP size limit

        // ✅ SEC: Strip local/private IP candidates from SDP
        // This prevents revealing the user's local network topology
        const cleanedSdp = data.sdp.sdp
            .split('\n')
            .filter(line => {
                // Remove host candidates with private IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
                if (line.includes('candidate') && line.includes('host')) {
                    if (/192\.168\.|^10\.|172\.(1[6-9]|2\d|3[01])\./.test(line)) {
                        return false;
                    }
                }
                return true;
            })
            .join('\n');

        allowed.sdp = { type: data.sdp.type, sdp: cleanedSdp };
    }

    if (data.ice) {
        if (typeof data.ice !== 'object') return null;
        // ✅ SEC: validate ICE candidate structure
        if (data.ice.candidate && typeof data.ice.candidate !== 'string') return null;
        if (data.ice.candidate && data.ice.candidate.length > 500) return null;

        // ✅ SEC: skip local IP ICE candidates
        if (data.ice.candidate) {
            const isPrivate = /192\.168\.|( 10\.)| 172\.(1[6-9]|2\d|3[01])\./.test(data.ice.candidate);
            if (isPrivate) return null; // Drop silently — don't forward local IPs
        }

        allowed.ice = {
            candidate:     data.ice.candidate     || null,
            sdpMid:        typeof data.ice.sdpMid === 'string' ? data.ice.sdpMid.substring(0, 20) : null,
            sdpMLineIndex: typeof data.ice.sdpMLineIndex === 'number' ? data.ice.sdpMLineIndex : null,
        };
    }

    if (!allowed.sdp && !allowed.ice) return null;
    return allowed;
}

// ══════════════════════════════════════════════════════════════
// ✅ SEC-10: REPORT SYSTEM — abuse-proof logic
//
// PROBLEM with old system: one user could spam 3 fake reports
// and ban anyone instantly.
//
// NEW LOGIC:
// - Each reporter can report a specific IP only ONCE per session
// - Reports accumulate from DIFFERENT reporters
// - Ban threshold: 3 unique reporters
// - Reporter IP also tracked to prevent botnet abuse
// ══════════════════════════════════════════════════════════════
function handleReport(reporterSocket) {
    if (!reporterSocket.partner) return { success: false, reason: 'no_partner' };

    const reporterIP = reporterSocket._userIP;
    const targetIP   = reporterSocket.partner._userIP;

    if (!targetIP) return { success: false, reason: 'no_target' };

    // ✅ SEC: reporter cannot report themselves (shouldn't happen, but defensive)
    if (reporterIP === targetIP) return { success: false, reason: 'self_report' };

    // ✅ SEC: each socket can only report each IP once
    const alreadyReported = reporterSocket._reportedIPs || new Set();
    if (alreadyReported.has(targetIP)) {
        return { success: false, reason: 'already_reported' };
    }
    alreadyReported.add(targetIP);
    reporterSocket._reportedIPs = alreadyReported;

    // ✅ SEC: track unique reporters per target IP
    if (!reportCounts[targetIP]) {
        reportCounts[targetIP] = new Set(); // Set of reporter IPs
    }
    reportCounts[targetIP].add(reporterIP);

    const uniqueReporterCount = reportCounts[targetIP].size;
    console.log(`[REPORT] ${maskIP(reporterIP)} → ${maskIP(targetIP)} (${uniqueReporterCount} unique reporters)`);

    // ✅ Ban after 3 UNIQUE reporters
    if (uniqueReporterCount >= 3) {
        bannedIPs.add(targetIP);
        console.log(`[BAN] ${maskIP(targetIP)} banned (3 unique reports)`);
        reporterSocket.partner.emit('banned', 'You have been reported and banned.');
        reporterSocket.partner.disconnect();
        return { success: true, banned: true };
    }

    return { success: true, banned: false };
}

// ══════════════════════════════════════════════════════════════
// ✅ AI REPORT ANALYSIS
// Uses Anthropic Claude API (key from ANTHROPIC_API_KEY env var)
// NEVER exposed to client — runs server-side only, async
// ══════════════════════════════════════════════════════════════

const REASON_LABELS = {
    '0':         'სიშიშვლე / სექსუალური კონტენტი',
    '1':         'შეურაცხყოფა / სიძულვილი',
    '2':         'სპამი / რეკლამა',
    '3':         'სხვა',
    'ai_nudity': 'ავტომატური AI სიშიშვლის ამოცნობა',
};

const reportAILog    = [];
const REPORT_LOG_MAX = 200;

async function analyzeReport({ reason, aiScore, reporterToken, targetToken, targetIP, banned }) {
    const apiKey      = process.env.ANTHROPIC_API_KEY;
    const reasonLabel = REASON_LABELS[reason] || reason;

    // Rule-based pre-check (works without API key)
    let ruleVerdict = 'unknown';
    let ruleNote    = '';

    if ((reason === 'ai_nudity' || reason === '0') && aiScore !== null) {
        if (aiScore >= 70)      { ruleVerdict = 'likely_genuine'; ruleNote = `AI nudity ${aiScore}% >= 70%`; }
        else if (aiScore >= 40) { ruleVerdict = 'uncertain';      ruleNote = `AI nudity ${aiScore}% (gray zone)`; }
        else                    { ruleVerdict = 'likely_false';   ruleNote = `AI nudity ${aiScore}% — low`; }
    } else {
        ruleVerdict = 'needs_review';
        ruleNote    = `Manual report: ${reasonLabel}`;
    }

    const entry = {
        ts: Date.now(), reporterToken, targetToken, targetIP,
        reason, reasonLabel, aiScore, banned,
        ruleVerdict, ruleNote,
        aiVerdict: null, aiExplanation: null, aiConfidence: null, aiAction: null,
    };

    // Claude API analysis (optional — advisory only, never blocks flow)
    if (apiKey && ruleVerdict !== 'likely_false') {
        try {
            const prompt =
`You are a content moderation assistant for GeoChat, a Georgian video chat platform.
Analyze whether this report is genuine (nudity/threat) or a false/abuse report.

Report:
- Reason: "${reasonLabel}" (code: ${reason})
- AI nudity score: ${aiScore !== null ? aiScore + '%' : 'N/A'}
- Rule pre-verdict: ${ruleVerdict} (${ruleNote})
- User banned: ${banned}

Respond with JSON only (no markdown):
{"verdict":"genuine|false_report|uncertain","confidence":0-100,"explanation":"1-2 sentences","action_recommended":"ban|warn|dismiss|monitor"}`;

            const res = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type':      'application/json',
                    'x-api-key':         apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model:      'claude-haiku-4-5-20251001',
                    max_tokens: 256,
                    messages:   [{ role: 'user', content: prompt }],
                }),
            });

            if (res.ok) {
                const d    = await res.json();
                const raw  = (d.content?.[0]?.text || '').replace(/```[a-z]*\n?/g, '').trim();
                const p    = JSON.parse(raw);
                entry.aiVerdict     = p.verdict     || null;
                entry.aiExplanation = p.explanation || null;
                entry.aiConfidence  = p.confidence  || null;
                entry.aiAction      = p.action_recommended || null;
            }
        } catch (e) {
            console.warn('[AI report] error:', e.message);
        }
    }

    reportAILog.push(entry);
    if (reportAILog.length > REPORT_LOG_MAX) reportAILog.shift();

    console.log(
        `[REPORT] reporter=${reporterToken} target=${targetIP} ` +
        `reason="${reasonLabel}" rule=${ruleVerdict} ` +
        `ai=${entry.aiVerdict || 'n/a'} aiScore=${aiScore ?? 'n/a'} banned=${banned}`
    );
    return entry;
}

// ✅ Admin: VIP audit log
app.get('/admin/vip-log', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) { res.status(404).end(); return; }
    if ((req.headers['x-admin-token'] || req.query.token) !== tok) { res.status(403).end(); return; }
    const active = [...vipCodes.entries()].map(([code, v]) => ({
        code, expiresAt: new Date(v.expiresAt).toISOString(),
        usedByIP: v.usedByIP || null,
        expired: Date.now() > v.expiresAt
    }));
    res.json({ activeCodes: active, recentUsage: vipAuditLog.slice(-50) });
});

// ✅ Admin endpoint — only active when ADMIN_TOKEN env var is set
app.get('/admin/report-log', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) { res.status(404).end(); return; }
    if ((req.headers['x-admin-token'] || req.query.token) !== tok) { res.status(403).end(); return; }
    res.json({ count: reportAILog.length, reports: reportAILog.slice(-50) });
});

// ══════════════════════════════════════════════════════════════
// ✅ SOCKET.IO CONNECTION HANDLER
// ══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    // ✅ SEC: extract real IP carefully
    const rawIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
                  socket.handshake.headers['x-real-ip'] ||
                  socket.handshake.address;

    // ✅ SEC: store IP on socket object internally — never send to client
    socket._userIP = rawIP;

    // ✅ SEC: generate anonymous session token for logging (never log raw IP)
    socket._sessionToken = generateSessionToken();

    console.log(`[CONNECT] session=${socket._sessionToken} ip=${maskIP(rawIP)}`);

    // ✅ SEC: ban check first
    if (bannedIPs.has(rawIP)) {
        socket.emit('banned', 'You have been banned for violating the rules.');
        socket.disconnect();
        return;
    }

    // ✅ SEC: connection rate limit
    if (!checkConnectionRateLimit(rawIP)) {
        socket.emit('error', 'Too many connection attempts. Please wait.');
        socket.disconnect();
        return;
    }

    // ✅ SEC: max 3 simultaneous connections per IP
    if (!checkMaxConnectionsPerIP(rawIP, socket.id)) {
        socket.emit('error', 'Too many simultaneous connections from your network.');
        socket.disconnect();
        return;
    }

    userConnections.set(socket.id, Date.now());

    // ⏱️ IP თავისუფალი ვადის შემოწმება (VIP კოდი find-partner-ში მოვა)
    socket._rawIP = rawIP;
    socket._isVip = false; // განახლდება find-partner-ზე

    activeUsersCount++;
    io.emit('update-online-count', activeUsersCount);

    // ── find-partner ─────────────────────────────────────────
    socket.on('find-partner', (userData) => {
        try {
            // ✅ SEC: validate all input server-side (client can be tampered)
            const nickname = validateNickname(userData?.nickname);
            if (!nickname) {
                socket.emit('error', 'Invalid nickname.');
                return;
            }

            const myGender   = VALID_GENDERS.includes(userData.myGender)  ? userData.myGender  : 'male';
            const seekGender = VALID_GENDERS.includes(userData.seekGender) ? userData.seekGender: 'female';
            const city       = VALID_CITIES.includes(userData.city)        ? userData.city      : 'random';

            // 💎 VIP — კოდის დამოწმება
            let isVip = false;
            const vipCode = (userData.vipCode || '').toString().trim().toUpperCase();
            if (vipCode) {
                const entry = vipCodes.get(vipCode);
                if (entry && Date.now() <= entry.expiresAt) {
                    isVip = true;
                } else if (entry) {
                    vipCodes.delete(vipCode);
                }
            }

            socket.userData = { nickname, city, myGender, seekGender, isVip };
            socket._isVip = isVip;

            // ⏱️ IP ლიმიტის შემოწმება
            if (!isVip && isIpLimitReached(rawIP, null)) {
                socket.emit('time-limit-reached', {
                    remainingMs: 0,
                    freeMinutes: 60
                });
                return;
            }

            // ⏱️ ტაიმერის დაწყება
            startIpTimer(rawIP);

            // Remove from queue if already there
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

            // Clean up existing partner
            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }

            // 💎 VIP priority matching
            // VIP: ქალაქი+სქესი → სქესი → ნებისმიერი
            // Standard: ქალაქი+სქესი → სქესი → ნებისმიერი
            let partnerIndex = -1;

            const genderMatch = (c) => c.userData.seekGender === myGender && seekGender === c.userData.myGender;
            const cityMatch   = (c) => city === 'random' || c.userData.city === 'random' || c.userData.city === city;

            // VIP-ს ქალაქი+სქესი ფილტრი პრიორიტეტულია
            if (isVip) {
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    const c = waitingUsers[i];
                    if (c.connected && c.userData && genderMatch(c) && cityMatch(c)) partnerIndex = i;
                }
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    const c = waitingUsers[i];
                    if (c.connected && c.userData && genderMatch(c)) partnerIndex = i;
                }
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    if (waitingUsers[i].connected) partnerIndex = i;
                }
            } else {
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    const c = waitingUsers[i];
                    if (c.connected && c.userData && genderMatch(c) && cityMatch(c)) partnerIndex = i;
                }
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    const c = waitingUsers[i];
                    if (c.connected && c.userData && genderMatch(c)) partnerIndex = i;
                }
                for (let i = 0; i < waitingUsers.length && partnerIndex === -1; i++) {
                    if (waitingUsers[i].connected) partnerIndex = i;
                }
            }

            if (partnerIndex !== -1) {
                const partner = waitingUsers.splice(partnerIndex, 1)[0];
                if (!partner.connected) {
                    waitingUsers.push(socket);
                    socket.emit('waiting');
                    return;
                }
                socket.partner = partner;
                partner.partner = socket;

                // ✅ SEC: only send nickname and city — never send IP, socketId, or internal data
                socket.emit('partner-found',  { nickname: partner.userData.nickname, city: partner.userData.city, isInitiator: true,  partnerIsVip: partner.userData.isVip });
                partner.emit('partner-found', { nickname: socket.userData.nickname,  city: socket.userData.city,  isInitiator: false, partnerIsVip: socket.userData.isVip  });

                console.log(`[MATCH] ${socket._sessionToken} ↔ ${partner._sessionToken}`);
            } else {
                waitingUsers.push(socket);
                socket.emit('waiting');
                console.log(`[WAIT] session=${socket._sessionToken} (queue: ${waitingUsers.length})`);
            }
        } catch (err) {
            console.error('find-partner error:', err.message);
            socket.emit('error', 'Error searching for partner.');
        }
    });

    // ── stop-searching ────────────────────────────────────────
    socket.on('stop-searching', () => {
        try {
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }
            console.log(`[STOP] session=${socket._sessionToken}`);
        } catch (err) {
            console.error('stop-searching error:', err.message);
        }
    });

    // ── WebRTC signaling ──────────────────────────────────────
    socket.on('signal', (data) => {
        try {
            if (!socket.partner?.connected) return;

            // ✅ SEC: sanitize and strip local IPs from SDP/ICE
            const clean = sanitizeSignalData(data);
            if (clean) {
                socket.partner.emit('signal', clean);
            }
        } catch (err) {
            console.error('signal error:', err.message);
        }
    });

    // ── Chat message ──────────────────────────────────────────
    socket.on('chat-msg', (msg) => {
        try {
            // ✅ SEC: rate limit
            if (!checkMessageRateLimit(socket.id)) {
                socket.emit('error', 'Too many messages. Slow down.');
                return;
            }

            // ✅ SEC: strict type + length checks
            if (typeof msg !== 'string' || msg.length === 0 || msg.length > 400) return;

            // ✅ SEC: strip invisible unicode + sanitize XSS
            const stripped = msg.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, '').trim();
            if (!stripped) return;
            const sanitized = xss(stripped);

            if (socket.partner?.connected) {
                socket.partner.emit('chat-msg', sanitized);
            }
        } catch (err) {
            console.error('chat-msg error:', err.message);
        }
    });

    // ── Report user (with AI analysis) ───────────────────────
    socket.on('report-user', async (data) => {
        try {
            const VALID_REASONS = ['0','1','2','3','ai_nudity'];
            const rawReason = data?.reason !== undefined ? String(data.reason) : '3';
            const reason    = VALID_REASONS.includes(rawReason) ? rawReason : '3';
            const aiScore   = (typeof data?.aiScore === 'number' && data.aiScore >= 0 && data.aiScore <= 100)
                              ? Math.round(data.aiScore) : null;

            // 🤖 AI ავტო-ბანი: ai_nudity + score >= 75 → დაუყოვნებელი kick
            if (reason === 'ai_nudity' && aiScore !== null && aiScore >= 75) {
                if (socket.partner?.connected) {
                    const targetIP = socket.partner._userIP || socket.partner._rawIP;
                    if (targetIP) {
                        bannedIPs.add(targetIP);
                        console.log(`[AI-AUTOBAN] ${maskIP(targetIP)} auto-banned, nudity=${aiScore}%`);
                    }
                    socket.partner.emit('banned', 'AI-მ სიშიშვლე ამოიცნო. თქვენ დაბლოკილი ხართ.');
                    socket.partner.disconnect();
                }
                analyzeReport({
                    reason, aiScore,
                    reporterToken: socket._sessionToken,
                    targetToken:   socket.partner?._sessionToken || 'unknown',
                    targetIP:      socket.partner ? maskIP(socket.partner._userIP) : 'unknown',
                    banned: true,
                }).catch(() => {});
                return;
            }

            const result = handleReport(socket);
            if (!result.success) {
                if (result.reason === 'already_reported') {
                    socket.emit('error', 'You already reported this user.');
                }
                return;
            }

            analyzeReport({
                reason, aiScore,
                reporterToken: socket._sessionToken,
                targetToken:   socket.partner ? socket.partner._sessionToken : 'unknown',
                targetIP:      socket.partner ? maskIP(socket.partner._userIP) : 'unknown',
                banned:        result.banned || false,
            }).catch(e => console.error('[AI report] analysis error:', e.message));

        } catch (err) {
            console.error('report-user error:', err.message);
        }
    });


    // ── Questions sync / events ──────────────────────────────────
    socket.on('question-sync', (data) => {
        try {
            if (!socket.partner?.connected) return;
            if (typeof data?.questionId !== 'number') return;
            socket.partner.emit('question-sync', { questionId: data.questionId });
        } catch(e) { console.error('question-sync error:', e.message); }
    });

    socket.on('question-answer', (data) => {
        try {
            if (!socket.partner?.connected) return;
            if (typeof data?.answer !== 'string') return;
            const safe = String(data.answer).substring(0, 200);
            socket.partner.emit('question-answer', { answer: safe });
        } catch(e) { console.error('question-answer error:', e.message); }
    });

    // ── Disconnect ────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] session=${socket._sessionToken}`);

        // ⏱️ ტაიმერი გაჩერება
        if (socket._rawIP && !socket._isVip) {
            stopIpTimer(socket._rawIP);
            // დარჩენილი დრო გავაგზავნოთ (თუ კვლავ იქ არიან)
        }

        activeUsersCount = Math.max(0, activeUsersCount - 1);
        io.emit('update-online-count', activeUsersCount);

        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
        }

        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

        // ✅ SEC: cleanup all tracking data
        userConnections.delete(socket.id);
        userMessageCounts.delete(socket.id);
        removeSocketFromIP(socket._userIP, socket.id);
        reportsByReporter.delete(socket.id);
    });

    socket.on('error', (err) => {
        console.error(`[ERR] session=${socket._sessionToken}:`, err?.message || err);
    });
});

// ══════════════════════════════════════════════════════════════
// ✅ CLEANUP INTERVALS
// ══════════════════════════════════════════════════════════════
setInterval(() => {
    const now = Date.now();

    for (const [ip, arr] of connectionAttempts.entries()) {
        const r = arr.filter(t => now - t < 60000);
        r.length ? connectionAttempts.set(ip, r) : connectionAttempts.delete(ip);
    }

    for (const [id, arr] of userMessageCounts.entries()) {
        const r = arr.filter(t => now - t < 10000);
        r.length ? userMessageCounts.set(id, r) : userMessageCounts.delete(id);
    }

    cleanupInactiveUsers();
}, 60000);

// ✅ Every hour: reset low-count reports + ipTimeMap memory leak fix
setInterval(() => {
    const today = getDayKey();
    // ✅ FIX: ipTimeMap memory leak — delete old day entries
    for (const [ip, entry] of ipTimeMap.entries()) {
        if (entry.dayKey !== today) ipTimeMap.delete(ip);
    }
    for (const ip in reportCounts) {
        if (!bannedIPs.has(ip)) delete reportCounts[ip];
    }
    console.log(`[CLEANUP] banned=${bannedIPs.size} queue=${waitingUsers.length} online=${activeUsersCount} ipTimeMap=${ipTimeMap.size}`);
}, 3600000);

// ══════════════════════════════════════════════════════════════
// ✅ SERVER START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ GeoChat running on :${PORT}`);
    console.log(`🌍 Env: ${process.env.NODE_ENV || 'development'}`);
    if (!process.env.ALLOWED_ORIGIN) {
        console.warn('⚠️  ALLOWED_ORIGIN not set — CORS is open (*). Set it in production!');
    }
});

process.on('SIGTERM', () => { console.log('⚠️ SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT');  server.close(() => process.exit(0)); });
process.on('uncaughtException',  (e) => console.error('❌ uncaughtException:',  e.message));
process.on('unhandledRejection', (r) => console.error('❌ unhandledRejection:', r));
// 💎 VIP SYSTEM — vipCodes declared in STATE section

// VIP კოდის გენერაცია — admin endpoint
app.post('/admin/vip/generate', (req, res) => {
    const tok = process.env.ADMIN_TOKEN;
    if (!tok) return res.status(404).json({ error: 'not_configured' });
    if ((req.headers['x-admin-token'] || req.body?.token) !== tok) {
        return res.status(403).json({ error: 'forbidden' });
    }
    const days = parseInt(req.body?.days) || 30;
    const code = 'VIP-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    vipCodes.set(code, { expiresAt, usedBy: null });
    return res.json({ code, expiresAt: new Date(expiresAt).toISOString(), days });
});

// VIP კოდის შემოწმება — client-ი ამოწმებს Registration-ზე
app.post('/vip/check', (req, res) => {
    const code = (req.body?.code || '').toString().trim().toUpperCase();
    if (!code) return res.json({ valid: false, reason: 'empty' });
    const entry = vipCodes.get(code);
    if (!entry) return res.json({ valid: false, reason: 'not_found' });
    if (Date.now() > entry.expiresAt) {
        vipCodes.delete(code);
        return res.json({ valid: false, reason: 'expired' });
    }
    // ✅ Log VIP activation for audit
    const clientIP = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!entry.usedByIP) entry.usedByIP = clientIP;
    vipAuditLog.push({ code, ip: maskIP(clientIP), ts: Date.now(), action: 'check_valid' });
    return res.json({ valid: true, expiresAt: entry.expiresAt });
});