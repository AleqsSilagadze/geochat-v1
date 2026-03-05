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
    message: "ბევრი მოთხოვნაა, გთხოვთ დაიცადოთ.",
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// ✅ FIX 1: Registration page is the entry point
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

app.get('/registration', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

// ✅ FIX 2: Added /chat route — was completely missing before!
app.get('/chat', (req, res) => {
    const { nickname } = req.query;

    // Validate that nickname exists and is not empty before serving chat
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

// 404 → back to registration
app.use((req, res) => {
    res.status(404).redirect('/');
});

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
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
const VALID_CITIES = ['random', 'თბილისი', 'ქუთაისი', 'ბათუმი', 'რუსთავი', 'გორი'];

function checkConnectionRateLimit(ip) {
    const now = Date.now();
    const attempts = connectionAttempts.get(ip) || [];
    const recentAttempts = attempts.filter(time => now - time < 60000);
    if (recentAttempts.length >= 10) return false;
    recentAttempts.push(now);
    connectionAttempts.set(ip, recentAttempts);
    return true;
}

function checkMessageRateLimit(socketId) {
    const now = Date.now();
    const userMessages = userMessageCounts.get(socketId) || [];
    const recentMessages = userMessages.filter(time => now - time < 10000);
    if (recentMessages.length >= 20) return false;
    recentMessages.push(now);
    userMessageCounts.set(socketId, recentMessages);
    return true;
}

function cleanupInactiveUsers() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000;
    waitingUsers = waitingUsers.filter(socket => {
        const connectionTime = userConnections.get(socket.id);
        if (connectionTime && now - connectionTime > timeout) {
            socket.emit('error', 'დროის ლიმიტი გავიდა');
            socket.disconnect();
            return false;
        }
        return true;
    });
}

io.on('connection', (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
        socket.handshake.headers['x-real-ip'] ||
        socket.handshake.address;

    console.log(`[${new Date().toISOString()}] New connection: ${socket.id} from ${userIP}`);

    if (!checkConnectionRateLimit(userIP)) {
        socket.emit('error', 'ძალიან ბევრი კავშირის მცდელობა');
        socket.disconnect();
        return;
    }

    if (bannedIPs.has(userIP)) {
        socket.emit('banned', 'თქვენ დაბლოკილი ხართ წესების დარღვევის გამო.');
        socket.disconnect();
        return;
    }

    userConnections.set(socket.id, Date.now());
    activeUsersCount++;
    io.emit('update-online-count', activeUsersCount);

    socket.on('find-partner', (userData) => {
        try {
            if (!userData || typeof userData.nickname !== 'string' ||
                userData.nickname.length < 2 || userData.nickname.length > 15) {
                socket.emit('error', 'არასწორი მონაცემები');
                return;
            }

            // ✅ FIX 3: Validate gender and city on server side
            const myGender = VALID_GENDERS.includes(userData.myGender) ? userData.myGender : 'male';
            const seekGender = VALID_GENDERS.includes(userData.seekGender) ? userData.seekGender : 'female';
            const city = VALID_CITIES.includes(userData.city) ? userData.city : 'random';

            socket.userData = {
                nickname: xss(userData.nickname.trim().substring(0, 15)),
                city: city,
                myGender: myGender,
                seekGender: seekGender
            };

            // Remove from waiting list if already there
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

            // Disconnect from current partner if exists
            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }

            // ✅ FIX 4: Try to find a compatible partner (gender matching)
            let partnerIndex = -1;
            for (let i = 0; i < waitingUsers.length; i++) {
                const candidate = waitingUsers[i];
                if (!candidate.connected || !candidate.userData) continue;

                const cityMatch = city === 'random' || candidate.userData.city === 'random' || candidate.userData.city === city;
                const genderMatch =
                    (candidate.userData.seekGender === myGender || candidate.userData.seekGender === 'any') &&
                    (seekGender === candidate.userData.myGender || seekGender === 'any');

                if (cityMatch && genderMatch) {
                    partnerIndex = i;
                    break;
                }
            }

            // Fallback: if no gender match found, match anyone
            if (partnerIndex === -1) {
                for (let i = 0; i < waitingUsers.length; i++) {
                    if (waitingUsers[i].connected) {
                        partnerIndex = i;
                        break;
                    }
                }
            }

            if (partnerIndex !== -1) {
                const partner = waitingUsers.splice(partnerIndex, 1)[0];

                if (!partner.connected) {
                    waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
                    waitingUsers.push(socket);
                    socket.emit('waiting');
                    return;
                }

                socket.partner = partner;
                partner.partner = socket;

                socket.emit('partner-found', {
                    nickname: partner.userData.nickname,
                    city: partner.userData.city,
                    isInitiator: true
                });
                partner.emit('partner-found', {
                    nickname: socket.userData.nickname,
                    city: socket.userData.city,
                    isInitiator: false
                });

                console.log(`[MATCH] ${socket.userData.nickname} ↔ ${partner.userData.nickname}`);
            } else {
                waitingUsers.push(socket);
                // ✅ FIX 5: Tell client they are now waiting (for Waiting.. UI)
                socket.emit('waiting');
                console.log(`[WAITING] ${socket.userData.nickname} added to queue (${waitingUsers.length})`);
            }
        } catch (error) {
            console.error('Error in find-partner:', error);
            socket.emit('error', 'შეცდომა პარტნიორის ძიებაში');
        }
    });

    // ✅ FIX 6: Stop searching — remove from waiting queue
    socket.on('stop-searching', () => {
        try {
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
            console.log(`[STOP] ${socket.userData?.nickname} stopped searching`);
        } catch (error) {
            console.error('Stop searching error:', error);
        }
    });

    socket.on('signal', (data) => {
        try {
            if (socket.partner && socket.partner.connected && data) {
                if (data.sdp || data.ice) {
                    socket.partner.emit('signal', data);
                }
            }
        } catch (error) {
            console.error('Signal error:', error);
        }
    });

    socket.on('chat-msg', (msg) => {
        try {
            if (!checkMessageRateLimit(socket.id)) {
                socket.emit('error', 'ძალიან ბევრი შეტყობინება');
                return;
            }
            if (typeof msg !== 'string' || msg.length === 0 || msg.length > 400) return;

            if (socket.partner && socket.partner.connected) {
                const sanitized = xss(msg.trim());
                socket.partner.emit('chat-msg', sanitized);
            }
        } catch (error) {
            console.error('Chat message error:', error);
        }
    });

    socket.on('report-user', () => {
        try {
            if (socket.partner) {
                const pIP = socket.partner.handshake.headers['x-forwarded-for']?.split(',')[0].trim() ||
                    socket.partner.handshake.headers['x-real-ip'] ||
                    socket.partner.handshake.address;

                reports[pIP] = (reports[pIP] || 0) + 1;
                console.log(`[REPORT] ${socket.userData?.nickname} reported ${socket.partner.userData?.nickname} (${reports[pIP]}/3)`);

                if (reports[pIP] >= 3) {
                    bannedIPs.add(pIP);
                    console.log(`[BAN] IP ${pIP} banned`);
                    socket.partner.emit('banned', 'თქვენ დაგარეპორტეს და დაიბლოკეთ.');
                    socket.partner.disconnect();
                }
            }
        } catch (error) {
            console.error('Report error:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ${socket.id} (${socket.userData?.nickname || 'unknown'})`);

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

    socket.on('error', (error) => {
        console.error(`[ERROR] Socket ${socket.id}:`, error);
    });
});

setInterval(() => {
    const now = Date.now();
    for (const [ip, attempts] of connectionAttempts.entries()) {
        const recent = attempts.filter(time => now - time < 60000);
        if (recent.length === 0) connectionAttempts.delete(ip);
        else connectionAttempts.set(ip, recent);
    }
    for (const [socketId, messages] of userMessageCounts.entries()) {
        const recent = messages.filter(time => now - time < 10000);
        if (recent.length === 0) userMessageCounts.delete(socketId);
        else userMessageCounts.set(socketId, recent);
    }
    cleanupInactiveUsers();
}, 60000);

setInterval(() => {
    for (const ip in reports) {
        if (reports[ip] < 3) delete reports[ip];
    }
    console.log(`[CLEANUP] Reports: ${Object.keys(reports).length}, Banned: ${bannedIPs.size}`);
}, 3600000);

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ GeoChat Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

process.on('SIGTERM', () => {
    server.close(() => { process.exit(0); });
});

process.on('SIGINT', () => {
    server.close(() => { process.exit(0); });
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});