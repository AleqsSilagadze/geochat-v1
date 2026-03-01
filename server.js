const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// Cloudflare-ისთვის IP-ს ნდობა
app.set('trust proxy', true);

// უსაფრთხოების ჰედერები (CSP)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdn.socket.io"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "font-src": ["'self'", "https://fonts.gstatic.com"],
            "connect-src": ["'self'", "wss:", "https:", "http:"]
        },
    },
}));

app.use(express.static('public'));

// Rate Limiting - მაქსიმუმ 50 მოთხოვნა 1 წუთში თითო IP-დან
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    message: "ბევრი მოთხოვნაა, გთხოვთ დაიცადოთ."
});
app.use(limiter);

const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let waitingUsers = [];
let activeUsersCount = 0;
const reports = {}; 
const bannedIPs = new Set();

io.on('connection', (socket) => {
    // რეალური IP-ს ამოღება (Cloudflare-ის გათვალისწინებით)
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(userIP)) {
        socket.emit('banned', 'თქვენ დაბლოკილი ხართ წესების დარღვევის გამო.');
        socket.disconnect();
        return;
    }

    activeUsersCount++;
    io.emit('update-online-count', activeUsersCount);

    socket.on('find-partner', (userData) => {
        // ვალიდაცია
        if (!userData || typeof userData.nickname !== 'string') return;
        
        socket.userData = {
            nickname: xss(userData.nickname.substring(0, 15)),
            city: xss(userData.city || 'უცნობი')
        };

        // ძველი რიგიდან ამოშლა
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);

        if (waitingUsers.length > 0) {
            const partner = waitingUsers.shift();
            
            socket.partner = partner;
            partner.partner = socket;

            socket.emit('partner-found', partner.userData);
            partner.emit('partner-found', socket.userData);
        } else {
            waitingUsers.push(socket);
        }
    });

    socket.on('signal', (data) => {
        if (socket.partner) socket.partner.emit('signal', data);
    });

    socket.on('chat-msg', (msg) => {
        if (typeof msg !== 'string' || msg.length > 400) return;
        if (socket.partner) {
            socket.partner.emit('chat-msg', xss(msg));
        }
    });

    socket.on('report-user', () => {
        if (socket.partner) {
            const pIP = socket.partner.handshake.headers['x-forwarded-for'] || socket.partner.handshake.address;
            reports[pIP] = (reports[pIP] || 0) + 1;
            if (reports[pIP] >= 3) bannedIPs.add(pIP);
            
            socket.partner.emit('banned', 'თქვენ დაგარეპორტეს და დაიბლოკეთ.');
            socket.partner.disconnect();
        }
    });

    socket.on('disconnect', () => {
        activeUsersCount = Math.max(0, activeUsersCount - 1);
        io.emit('update-online-count', activeUsersCount);
        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
        }
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
    });
});

server.listen(3000, () => console.log('Server is running on port 3000'));