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

// Enhanced Helmet security
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "connect-src": ["'self'", "wss:", "https:", "http:", "ws:"],
            "img-src": ["'self'", "data:", "https:"],
            "media-src": ["'self'", "blob:"], // ✅ NEW: For WebRTC media
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    message: "ბევრი მოთხოვნაა, გთხოვთ დაიცადოთ.",
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main_page.html'));
});

app.get('/registration', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'Registration.html'));
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
    res.status(404).sendFile(path.join(__dirname, 'public', 'Registration.html'));
});

// Socket.io configuration
const io = socketIo(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6, // ✅ NEW: 1MB max message size
    transports: ['websocket', 'polling'] // ✅ NEW: Better connection handling
});

let waitingUsers = [];
let activeUsersCount = 0;
const reports = {}; 
const bannedIPs = new Set();
const connectionAttempts = new Map();
const userMessageCounts = new Map(); // ✅ NEW: Server-side message rate limiting
const userConnections = new Map(); // ✅ NEW: Track user connections

// ✅ NEW: IP-based rate limiting for connections
function checkConnectionRateLimit(ip) {
    const now = Date.now();
    const attempts = connectionAttempts.get(ip) || [];
    const recentAttempts = attempts.filter(time => now - time < 60000);
    
    if (recentAttempts.length >= 10) return false;
    
    recentAttempts.push(now);
    connectionAttempts.set(ip, recentAttempts);
    return true;
}

// ✅ NEW: Message rate limiting per user
function checkMessageRateLimit(socketId) {
    const now = Date.now();
    const userMessages = userMessageCounts.get(socketId) || [];
    const recentMessages = userMessages.filter(time => now - time < 10000); // 10 seconds
    
    if (recentMessages.length >= 20) return false; // Max 20 messages per 10 seconds
    
    recentMessages.push(now);
    userMessageCounts.set(socketId, recentMessages);
    return true;
}

// ✅ NEW: Cleanup inactive waiting users
function cleanupInactiveUsers() {
    const now = Date.now();
    const timeout = 5 * 60 * 1000; // 5 minutes
    
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

    // Connection rate limiting
    if (!checkConnectionRateLimit(userIP)) {
        socket.emit('error', 'ძალიან ბევრი კავშირის მცდელობა');
        socket.disconnect();
        return;
    }

    // Ban check
    if (bannedIPs.has(userIP)) {
        socket.emit('banned', 'თქვენ დაბლოკილი ხართ წესების დარღვევის გამო.');
        socket.disconnect();
        return;
    }

    // ✅ NEW: Track connection time
    userConnections.set(socket.id, Date.now());
    
    activeUsersCount++;
    io.emit('update-online-count', activeUsersCount);

    // Find partner with validation
    socket.on('find-partner', (userData) => {
        try {
            if (!userData || typeof userData.nickname !== 'string' || 
                userData.nickname.length < 2 || userData.nickname.length > 15) {
                socket.emit('error', 'არასწორი მონაცემები');
                return;
            }
            
            socket.userData = {
                nickname: xss(userData.nickname.trim().substring(0, 15)),
                city: xss((userData.city || 'უცნობი').substring(0, 30))
            };

            // ✅ NEW: Remove from waiting list if already there
            waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

            // ✅ NEW: Disconnect from current partner if exists
            if (socket.partner) {
                socket.partner.emit('partner-disconnected');
                socket.partner.partner = null;
                socket.partner = null;
            }

            if (waitingUsers.length > 0) {
                const partner = waitingUsers.shift();
                
                // ✅ NEW: Validate partner still connected
                if (!partner.connected) {
                    socket.emit('find-partner', userData); // Retry
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
                console.log(`[WAITING] ${socket.userData.nickname} added to queue (${waitingUsers.length})`);
            }
        } catch (error) {
            console.error('Error in find-partner:', error);
            socket.emit('error', 'შეცდომა პარტნიორის ძიებაში');
        }
    });

    // WebRTC signaling with validation
    socket.on('signal', (data) => {
        try {
            if (socket.partner && socket.partner.connected && data) {
                // ✅ NEW: Validate signal data structure
                if (data.sdp || data.ice) {
                    socket.partner.emit('signal', data);
                }
            }
        } catch (error) {
            console.error('Signal error:', error);
        }
    });

    // Chat message with enhanced validation
    socket.on('chat-msg', (msg) => {
        try {
            // ✅ NEW: Server-side rate limiting
            if (!checkMessageRateLimit(socket.id)) {
                socket.emit('error', 'ძალიან ბევრი შეტყობინება');
                return;
            }

            if (typeof msg !== 'string' || msg.length === 0 || msg.length > 400) {
                return;
            }

            if (socket.partner && socket.partner.connected) {
                const sanitized = xss(msg.trim());
                socket.partner.emit('chat-msg', sanitized);
                console.log(`[MSG] ${socket.userData?.nickname} → ${socket.partner.userData?.nickname}`);
            }
        } catch (error) {
            console.error('Chat message error:', error);
        }
    });

    // ✅ ENHANCED: Report system with better tracking
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

    // Disconnect handler
    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] ${socket.id} (${socket.userData?.nickname || 'unknown'})`);
        
        activeUsersCount = Math.max(0, activeUsersCount - 1);
        io.emit('update-online-count', activeUsersCount);
        
        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
        }
        
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
        
        // ✅ NEW: Cleanup user tracking data
        userConnections.delete(socket.id);
        userMessageCounts.delete(socket.id);
    });

    // Error handler
    socket.on('error', (error) => {
        console.error(`[ERROR] Socket ${socket.id}:`, error);
    });
});

// ✅ NEW: Cleanup intervals
setInterval(() => {
    const now = Date.now();
    
    // Cleanup old connection attempts
    for (const [ip, attempts] of connectionAttempts.entries()) {
        const recent = attempts.filter(time => now - time < 60000);
        if (recent.length === 0) {
            connectionAttempts.delete(ip);
        } else {
            connectionAttempts.set(ip, recent);
        }
    }
    
    // Cleanup old message counts
    for (const [socketId, messages] of userMessageCounts.entries()) {
        const recent = messages.filter(time => now - time < 10000);
        if (recent.length === 0) {
            userMessageCounts.delete(socketId);
        } else {
            userMessageCounts.set(socketId, recent);
        }
    }
    
    // Cleanup inactive waiting users
    cleanupInactiveUsers();
    
}, 60000); // Every minute

// ✅ NEW: Cleanup old bans and reports every hour
setInterval(() => {
    // Reset reports older than 24 hours
    const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
    for (const ip in reports) {
        if (reports[ip] < 3) {
            delete reports[ip];
        }
    }
    
    console.log(`[CLEANUP] Reports: ${Object.keys(reports).length}, Banned: ${bannedIPs.size}`);
}, 3600000); // Every hour

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ GeoChat Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('⚠️ SIGTERM received: closing server');
    server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('⚠️ SIGINT received: closing server');
    server.close(() => {
        console.log('✅ Server closed gracefully');
        process.exit(0);
    });
});

// ✅ NEW: Unhandled error logging
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});