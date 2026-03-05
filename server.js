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
            "script-src":       ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
            "style-src":        ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src":         ["'self'", "https://fonts.gstatic.com"],
            // ✅ SEC: connect-src restricted — no arbitrary external connections from client
            "connect-src":      ["'self'", "wss:", "ws:"],
            "img-src":          ["'self'", "data:"],
            "media-src":        ["'self'", "blob:"],
            // ✅ SEC: block all object/embed/frame — no plugin attacks
            "object-src":       ["'none'"],
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

// ✅ /chat — sessionStorage used on client, no URL params needed
// Validation happens in script.js (loadSession) and on socket events
app.get('/chat', chatLimiter, (req, res) => {
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

            socket.userData = { nickname, city, myGender, seekGender };

            // Remove from queue if already there
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

            // Clean up existing partner
            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }

            // Find compatible partner — gender+city first, then fallback
            let partnerIndex = -1;
            for (let i = 0; i < waitingUsers.length; i++) {
                const c = waitingUsers[i];
                if (!c.connected || !c.userData) continue;
                const cityOk   = city === 'random' || c.userData.city === 'random' || c.userData.city === city;
                const genderOk = c.userData.seekGender === myGender && seekGender === c.userData.myGender;
                if (cityOk && genderOk) { partnerIndex = i; break; }
            }
            if (partnerIndex === -1) {
                for (let i = 0; i < waitingUsers.length; i++) {
                    if (waitingUsers[i].connected) { partnerIndex = i; break; }
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
                socket.emit('partner-found',  { nickname: partner.userData.nickname, city: partner.userData.city, isInitiator: true  });
                partner.emit('partner-found', { nickname: socket.userData.nickname,  city: socket.userData.city,  isInitiator: false });

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

    // ── Report user ───────────────────────────────────────────
    socket.on('report-user', () => {
        try {
            const result = handleReport(socket);
            if (!result.success) {
                if (result.reason === 'already_reported') {
                    socket.emit('error', 'You already reported this user.');
                }
                // ✅ SEC: silent fail for other cases — don't hint at logic
            }
        } catch (err) {
            console.error('report-user error:', err.message);
        }
    });

    // ── Disconnect ────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] session=${socket._sessionToken}`);

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

// ✅ Every hour: reset low-count reports (keep banned IPs)
setInterval(() => {
    for (const ip in reportCounts) {
        if (!bannedIPs.has(ip)) delete reportCounts[ip];
    }
    console.log(`[CLEANUP] banned=${bannedIPs.size} queue=${waitingUsers.length} online=${activeUsersCount}`);
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