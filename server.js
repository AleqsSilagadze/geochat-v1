const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "connect-src": ["'self'", "wss:", "https:", "http:", "ws:"],
            "img-src": ["'self'", "data:", "https:"],
            "media-src": ["'self'", "blob:"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    message: "Too many requests, please wait.",
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Registration is the entry point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

app.get('/registration', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

// Chat page — validates nickname before serving
app.get('/chat', (req, res) => {
    const { nickname } = req.query;
    if (!nickname || typeof nickname !== 'string' || nickname.trim().length < 2) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'main_page.html'));
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        online: activeUsersCount,
        waiting: waitingUsers.length,
        banned: bannedIPs.size
    });
});

app.use((req, res) => {
    res.status(404).redirect('/');
});

const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6,
    transports: ['websocket', 'polling']
});

let waitingUsers = [];
let activeUsersCount = 0;
const reports = {};
const bannedIPs = new Set();
const connectionAttempts = new Map();
const userMessageCounts = new Map();
const userConnections = new Map();

const VALID_GENDERS = ['male', 'female'];
const VALID_CITIES  = ['random', 'თბილისი', 'ქუთაისი', 'ბათუმი', 'რუსთავი', 'გორი'];

function checkConnectionRateLimit(ip) {
    const now = Date.now();
    const attempts = connectionAttempts.get(ip) || [];
    const recent = attempts.filter(t => now - t < 60000);
    if (recent.length >= 10) return false;
    recent.push(now);
    connectionAttempts.set(ip, recent);
    return true;
}

function checkMessageRateLimit(socketId) {
    const now = Date.now();
    const msgs = userMessageCounts.get(socketId) || [];
    const recent = msgs.filter(t => now - t < 10000);
    if (recent.length >= 20) return false;
    recent.push(now);
    userMessageCounts.set(socketId, recent);
    return true;
}

function cleanupInactiveUsers() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    waitingUsers = waitingUsers.filter(socket => {
        const t = userConnections.get(socket.id);
        if (t && now - t > timeout) {
            socket.emit('error', 'Session timed out.');
            socket.disconnect();
            return false;
        }
        return true;
    });
}

io.on('connection', (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
        socket.handshake.headers['x-real-ip'] || socket.handshake.address;

    console.log(`[${new Date().toISOString()}] Connect: ${socket.id} ${userIP}`);

    if (!checkConnectionRateLimit(userIP)) {
        socket.emit('error', 'Too many connection attempts.');
        socket.disconnect(); return;
    }
    if (bannedIPs.has(userIP)) {
        socket.emit('banned', 'You have been banned for violating the rules.');
        socket.disconnect(); return;
    }

    userConnections.set(socket.id, Date.now());
    activeUsersCount++;
    io.emit('update-online-count', activeUsersCount);

    socket.on('find-partner', (userData) => {
        try {
            if (!userData || typeof userData.nickname !== 'string' ||
                userData.nickname.length < 2 || userData.nickname.length > 15) {
                socket.emit('error', 'Invalid data.');
                return;
            }

            const myGender   = VALID_GENDERS.includes(userData.myGender)   ? userData.myGender   : 'male';
            const seekGender = VALID_GENDERS.includes(userData.seekGender)  ? userData.seekGender : 'female';
            const city       = VALID_CITIES.includes(userData.city)         ? userData.city       : 'random';

            socket.userData = {
                nickname:   xss(userData.nickname.trim().substring(0, 15)),
                city,
                myGender,
                seekGender
            };

            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }

            // Try gender+city match first, fallback to anyone
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

                socket.emit('partner-found',  { nickname: partner.userData.nickname, city: partner.userData.city, isInitiator: true  });
                partner.emit('partner-found', { nickname: socket.userData.nickname,  city: socket.userData.city,  isInitiator: false });
                console.log(`[MATCH] ${socket.userData.nickname} ↔ ${partner.userData.nickname}`);
            } else {
                waitingUsers.push(socket);
                socket.emit('waiting');
                console.log(`[WAIT] ${socket.userData.nickname} (queue: ${waitingUsers.length})`);
            }
        } catch (e) {
            console.error('find-partner error:', e);
            socket.emit('error', 'Error searching for partner.');
        }
    });

    socket.on('stop-searching', () => {
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
            socket.partner = null;
        }
        console.log(`[STOP] ${socket.userData?.nickname}`);
    });

    socket.on('signal', (data) => {
        try {
            if (socket.partner?.connected && data && (data.sdp || data.ice)) {
                socket.partner.emit('signal', data);
            }
        } catch (e) { console.error('signal error:', e); }
    });

    socket.on('chat-msg', (msg) => {
        try {
            if (!checkMessageRateLimit(socket.id)) { socket.emit('error', 'Too many messages.'); return; }
            if (typeof msg !== 'string' || !msg.length || msg.length > 400) return;
            if (socket.partner?.connected) {
                socket.partner.emit('chat-msg', xss(msg.trim()));
            }
        } catch (e) { console.error('chat-msg error:', e); }
    });

    socket.on('report-user', () => {
        try {
            if (!socket.partner) return;
            const pIP = socket.partner.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
                socket.partner.handshake.headers['x-real-ip'] || socket.partner.handshake.address;
            reports[pIP] = (reports[pIP] || 0) + 1;
            console.log(`[REPORT] ${socket.userData?.nickname} → ${socket.partner.userData?.nickname} (${reports[pIP]}/3)`);
            if (reports[pIP] >= 3) {
                bannedIPs.add(pIP);
                socket.partner.emit('banned', 'You have been reported and banned.');
                socket.partner.disconnect();
            }
        } catch (e) { console.error('report error:', e); }
    });

    socket.on('disconnect', () => {
        console.log(`[DC] ${socket.id} (${socket.userData?.nickname || '?'})`);
        activeUsersCount = Math.max(0, activeUsersCount - 1);
        io.emit('update-online-count', activeUsersCount);
        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
        }
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
        userConnections.delete(socket.id);
        userMessageCounts.delete(socket.id);
    });

    socket.on('error', (e) => console.error(`[ERR] ${socket.id}:`, e));
});

// Cleanup intervals
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

setInterval(() => {
    for (const ip in reports) { if (reports[ip] < 3) delete reports[ip]; }
    console.log(`[CLEANUP] reports:${Object.keys(reports).length} banned:${bannedIPs.size}`);
}, 3600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ GeoChat running on :${PORT}`);
    console.log(`🌍 ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
process.on('uncaughtException',   (e) => console.error('❌ uncaughtException:', e));
process.on('unhandledRejection',  (r) => console.error('❌ unhandledRejection:', r));