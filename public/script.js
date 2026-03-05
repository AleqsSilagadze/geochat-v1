const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
});

// ─── DOM refs ────────────────────────────────────────────────
const localVideo    = document.getElementById('localVideo');
const remoteVideo   = document.getElementById('remoteVideo');
const msgInput      = document.getElementById('msg-input');
const chatBox       = document.getElementById('chat-box');
const loader        = document.getElementById('loader');
const loaderText    = document.getElementById('loader-text');
const stoppedOverlay= document.getElementById('stopped-overlay');
const stopBtn       = document.getElementById('stop-btn');

// ─── State ───────────────────────────────────────────────────
let localStream;
let peerConnection;
let isSearching  = false;   // in waiting queue
let hasPartner   = false;   // in active call
let isStopped    = true;    // true = paused (START shown), false = active (STOP shown)
let lastMessageTime = 0;

// ─── WebRTC config ───────────────────────────────────────────
const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80',           username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443',          username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceCandidatePoolSize: 10
};

// ─── Toast notification system ───────────────────────────────
/*
  types: 'system' | 'info' | 'warn' | 'success' | 'error'
  System toasts show "System:" label in red, others show their type label.
*/
function showToast(message, type = 'system') {
    const container = document.getElementById('toast-container');

    const icons = {
        system:  '⚠️',
        info:    'ℹ️',
        warn:    '⚡',
        success: '✅',
        error:   '🚫'
    };

    const labels = {
        system:  'System',
        info:    'Info',
        warn:    'Warning',
        success: 'Success',
        error:   'Error'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${icons[type] || '⚠️'}</div>
        <div class="toast-body">
            <div class="toast-label">${labels[type] || 'System'}</div>
            <div class="toast-message">${sanitizeHTML(message)}</div>
        </div>
        <div class="toast-progress"></div>
    `;

    container.appendChild(toast);

    // Auto-remove after 5s
    const timer = setTimeout(() => dismissToast(toast), 5000);

    // Click to dismiss early
    toast.addEventListener('click', () => {
        clearTimeout(timer);
        dismissToast(toast);
    });
}

function dismissToast(toast) {
    if (!toast.parentNode) return;
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

// ─── Helpers ─────────────────────────────────────────────────
function sanitizeHTML(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function appendChatMessage(sender, text, senderClass) {
    const row = document.createElement('div');
    row.className = 'chat-msg-row';
    row.innerHTML = `<span class="msg-sender ${senderClass}">${sanitizeHTML(sender)}:</span><span>${sanitizeHTML(text)}</span>`;
    chatBox.appendChild(row);
    if (chatBox.children.length > 120) chatBox.removeChild(chatBox.firstChild);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function setLoaderText(mode) {
    const text = mode === 'waiting' ? 'Waiting..' : 'Loading..';
    loaderText.setAttribute('data-glitch', text);
    loaderText.textContent = text;
}

function showLoader(mode = 'loading') {
    stoppedOverlay.classList.remove('active');
    loader.style.display = 'flex';
    setLoaderText(mode);
}

function hideLoader() {
    loader.style.display = 'none';
}

function showStopped() {
    loader.style.display = 'none';
    stoppedOverlay.classList.add('active');
}

function hideStopped() {
    stoppedOverlay.classList.remove('active');
}

// Toggle stop button between START (green) and STOP (grey)
function setButtonState(state) {
    // state: 'start' | 'stop'
    stopBtn.dataset.state = state;
    if (state === 'start') {
        stopBtn.textContent = 'START';
        stopBtn.classList.add('start-mode');
        stopBtn.classList.remove('stop-mode');
        isStopped = true;
    } else {
        stopBtn.textContent = 'STOP';
        stopBtn.classList.add('stop-mode');
        stopBtn.classList.remove('start-mode');
        isStopped = false;
    }
}

function getURLParams() {
    const params = new URLSearchParams(window.location.search);
    let nickname  = (params.get('nickname') || 'Guest').trim().substring(0, 15).replace(/[^\wა-ჰ0-9]/gi, '');
    let city      = params.get('city')       || 'random';
    let myGender  = params.get('myGender')   || 'male';
    let seekGender= params.get('seekGender') || 'female';
    if (nickname.length < 2) nickname = 'Guest';
    return { nickname, city, myGender, seekGender };
}

// ─── WebRTC ──────────────────────────────────────────────────
function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(t => t.stop());
        remoteVideo.srcObject = null;
    }
    hasPartner = false;
    isSearching = false;
}

async function initWebRTC() {
    cleanupPeerConnection();
    peerConnection = new RTCPeerConnection(config);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { ice: e.candidate });
    };

    peerConnection.ontrack = (e) => {
        if (remoteVideo.srcObject !== e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            hideLoader();
            hasPartner = true;
        }
    };

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection?.connectionState;
        if (state === 'failed') {
            showToast('Connection failed. Searching for new partner...', 'error');
            showLoader('loading');
        }
        if (state === 'disconnected') {
            showToast('Connection lost.', 'warn');
        }
        if (state === 'connected') {
            hasPartner = true;
        }
    };
}

// ─── App start ───────────────────────────────────────────────
async function startApp() {
    showLoader('loading');

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });

        localVideo.srcObject = localStream;

        const { nickname } = getURLParams();
        document.getElementById('my-name-display').textContent = nickname;

        // On arrival from registration: show START button, show stopped overlay
        // User must press START to begin searching
        hideLoader();
        showStopped();
        setButtonState('start');

    } catch (err) {
        let msg = 'Camera and microphone access is required!';
        if (err.name === 'NotAllowedError')  msg = 'Permission denied. Please allow camera and microphone access.';
        if (err.name === 'NotFoundError')    msg = 'No camera or microphone found.';
        alert(msg);
        window.location.href = '/';
    }
}

function beginSearch() {
    const params = getURLParams();
    isSearching = true;
    hideStopped();
    showLoader('loading');
    socket.emit('find-partner', params);
    document.getElementById('partner-name-display').textContent = 'Partner';
}

function stopSearch() {
    isSearching = false;
    hasPartner = false;
    cleanupPeerConnection();
    socket.emit('stop-searching');
    showStopped();
    document.getElementById('partner-name-display').textContent = 'Partner';
}

// ─── Stop/Start toggle button ────────────────────────────────
stopBtn.addEventListener('click', () => {
    if (isStopped) {
        // Was stopped → now start
        setButtonState('stop');
        beginSearch();
    } else {
        // Was running → now stop
        setButtonState('start');
        stopSearch();
    }
});

// ─── Next button ─────────────────────────────────────────────
document.getElementById('next-btn').addEventListener('click', () => {
    if (isStopped) {
        // If currently stopped, next also starts search
        setButtonState('stop');
    }
    cleanupPeerConnection();
    chatBox.innerHTML = '';
    beginSearch();
});

// ─── Report button ───────────────────────────────────────────
document.getElementById('report-btn').addEventListener('click', () => {
    if (!hasPartner) {
        showToast('You need a partner to send a report.', 'system');
        return;
    }
    if (confirm('Are you sure you want to report this user?')) {
        socket.emit('report-user');
        showToast('Report submitted successfully.', 'success');
    }
});

// ─── Send message ────────────────────────────────────────────
function sendMessage() {
    const text = msgInput.value.trim();
    if (!text) return;

    if (!hasPartner) {
        showToast('No partner connected yet.', 'system');
        return;
    }

    const now = Date.now();
    if (now - lastMessageTime < 200) {
        showToast('You are typing too fast.', 'warn');
        return;
    }
    if (text.length > 400) {
        showToast('Message is too long (max 400 chars).', 'warn');
        return;
    }

    socket.emit('chat-msg', text);
    appendChatMessage('You', text, 'me');
    msgInput.value = '';
    lastMessageTime = now;
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ─── Socket events ───────────────────────────────────────────
socket.on('waiting', () => {
    isSearching = true;
    hasPartner = false;
    showLoader('waiting');
});

socket.on('partner-found', async (data) => {
    isSearching = false;
    hasPartner = true;
    chatBox.innerHTML = '';

    const label = `${sanitizeHTML(data.nickname)} (${sanitizeHTML(data.city)})`;
    document.getElementById('partner-name-display').textContent = label;

    showLoader('loading');
    await initWebRTC();

    if (data.isInitiator) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { sdp: offer });
        } catch (err) {
            console.error('Offer creation failed:', err);
            showToast('Could not create connection offer.', 'error');
        }
    }
});

socket.on('signal', async (data) => {
    if (!peerConnection) await initWebRTC();
    try {
        if (data.sdp) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type === 'offer') {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('signal', { sdp: answer });
            }
        } else if (data.ice) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice));
        }
    } catch (err) {
        console.error('Signaling error:', err);
    }
});

socket.on('chat-msg', (msg) => {
    appendChatMessage('Partner', msg, 'partner');
});

socket.on('update-online-count', (count) => {
    document.getElementById('user-count').textContent = count;
});

socket.on('partner-disconnected', () => {
    showToast('Partner disconnected.', 'warn');
    cleanupPeerConnection();
    chatBox.innerHTML = '';
    document.getElementById('partner-name-display').textContent = 'Partner';

    // Auto-search next if we were not stopped
    if (!isStopped) {
        beginSearch();
    } else {
        showStopped();
    }
});

socket.on('banned', (msg) => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    document.body.innerHTML = `
        <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;">
            <div style="text-align:center;color:white;">
                <h1 style="color:#ef4444;margin-bottom:20px;font-size:2rem;">⛔ Banned</h1>
                <p style="font-size:1.1rem;color:rgba(255,255,255,0.7);">${sanitizeHTML(msg)}</p>
            </div>
        </div>`;
});

socket.on('error', (msg) => {
    showToast(msg, 'error');
});

// ─── Cleanup on close ────────────────────────────────────────
window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    cleanupPeerConnection();
});

// ─── Boot ────────────────────────────────────────────────────
startApp();