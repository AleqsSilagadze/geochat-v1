const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const xss = require('xss');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);

// Content Security Policy-ს გამართვა Render/Production-ისთვის
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

const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: "ბევრი მოთხოვნაა, გთხოვთ დაიცადოთ."
});
app.use(limiter);

const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let waitingUsers = []; 
const bannedIPs = new Set();
const reports = {};

io.on('connection', (socket) => {
    const userIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    if (bannedIPs.has(userIP)) {
        socket.emit('banned', 'თქვენ დაბლოკილი ხართ წესების დარღვევის გამო.');
        socket.disconnect();
        return;
    }

    io.emit('update-online-count', io.engine.clientsCount);

    socket.on('find-partner', (userData) => {
        // მონაცემების გაწმენდა და ვალიდაცია
        const cleanData = {
            nickname: xss(userData.nickname?.substring(0, 15) || 'სტუმარი'),
            city: xss(userData.city || 'უცნობი'),
            myGender: userData.myGender === 'female' ? 'female' : 'male',
            seekGender: userData.seekGender === 'female' ? 'female' : 'male'
        };

        socket.userData = cleanData;
        
        // ვეძებთ მეწყვილეს, რომელიც აკმაყოფილებს სქესის კრიტერიუმს
        let partnerIndex = waitingUsers.findIndex(u => 
            u.userData.myGender === socket.userData.seekGender && 
            u.userData.seekGender === socket.userData.myGender
        );

        // თუ ზუსტი ვერ ვიპოვეთ, ველოდებით 5 წამს და მერე ნებისმიერზე გადაგვყავს (კლიენტზეა დამოკიდებული)
        if (partnerIndex === -1) {
            partnerIndex = waitingUsers.findIndex(u => u.id !== socket.id); 
        }

        if (partnerIndex !== -1) {
            const partner = waitingUsers.splice(partnerIndex, 1)[0];
            
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
            if (reports[pIP] >= 5) bannedIPs.add(pIP);
            
            socket.partner.emit('banned', 'თქვენ დაგარეპორტეს და დაიბლოკეთ.');
            socket.partner.disconnect();
        }
    });

    socket.on('disconnect', () => {
        io.emit('update-online-count', io.engine.clientsCount);
        if (socket.partner) {
            socket.partner.emit('partner-disconnected');
            socket.partner.partner = null;
        }
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));