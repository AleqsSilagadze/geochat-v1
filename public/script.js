const socket = io({
    reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 5,
    transports: ['websocket', 'polling'], withCredentials: false,
});

// ─── DOM ──────────────────────────────────────────────────────
const localVideo     = document.getElementById('localVideo');
const remoteVideo    = document.getElementById('remoteVideo');
const msgInput       = document.getElementById('msg-input');
const chatBox        = document.getElementById('chat-box');
const loader         = document.getElementById('loader');
const loaderText     = document.getElementById('loader-text');
const stoppedOverlay = document.getElementById('stopped-overlay');
const stopBtn        = document.getElementById('stop-btn');

// ─── State ────────────────────────────────────────────────────
let localStream      = null;
let peerConnection   = null;
let isSearching      = false;
let hasPartner       = false;
let isStopped        = true;
let lastMsgTime      = 0;
let sessionData      = null;
let iceCandidateQueue = [];
let isInitiatorRole  = false;
let partnerNickname  = 'Partner'; // stores real partner name for chat

// ─── WebRTC Config ─────────────────────────────────────────────
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        {
            urls: [
                'turn:openrelay.metered.ca:80',
                'turn:openrelay.metered.ca:443',
                'turn:openrelay.metered.ca:443?transport=tcp'
            ],
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all',
};

const VALID_CITIES  = ['random','თბილისი','ბათუმი','ქუთაისი','რუსთავი','გორი',
                       'ზუგდიდი','ფოთი','ხაშური','სამტრედია','სენაკი','ხონი'];
const VALID_GENDERS = ['male','female'];
const SESSION_MAX_AGE = 30 * 60 * 1000;

// ─── Session ──────────────────────────────────────────────────
function loadSession() {
    try {
        const raw = sessionStorage.getItem('gc_session');
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data.ts || Date.now() - data.ts > SESSION_MAX_AGE) {
            sessionStorage.removeItem('gc_session'); return null;
        }
        let nick = (data.nickname||'').trim()
            .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g,'')
            .replace(/[^\wა-ჰ0-9]/gi,'').substring(0,15);
        if (nick.length < 2) return null;
        const city       = VALID_CITIES.includes(data.city)        ? data.city       : 'random';
        const myGender   = VALID_GENDERS.includes(data.myGender)   ? data.myGender   : 'male';
        const seekGender = VALID_GENDERS.includes(data.seekGender) ? data.seekGender : 'female';
        return { nickname: nick, city, myGender, seekGender };
    } catch { sessionStorage.removeItem('gc_session'); return null; }
}
function clearSession() { sessionStorage.removeItem('gc_session'); }

// ─── Sanitize ─────────────────────────────────────────────────
function sanitizeText(raw) {
    const d = document.createElement('div');
    d.textContent = String(raw ?? ''); return d.textContent;
}
function escapeHTML(s) {
    return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#x27;')
        .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g,'');
}

// ─── Toast ────────────────────────────────────────────────────
function showToast(message, type='system') {
    const c = document.getElementById('toast-container');
    const icons  = {system:'⚠️',info:'ℹ️',warn:'⚡',success:'✅',error:'🚫'};
    const labels = {system:'System',info:'Info',warn:'Warning',success:'Success',error:'Error'};
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `
        <div class="toast-icon">${icons[type]||'⚠️'}</div>
        <div class="toast-body">
            <div class="toast-label">${escapeHTML(labels[type]||'System')}</div>
            <div class="toast-message">${escapeHTML(message)}</div>
        </div>
        <div class="toast-progress"></div>`;
    c.appendChild(t);
    const timer = setTimeout(() => dismiss(t), 5000);
    t.addEventListener('click', () => { clearTimeout(timer); dismiss(t); });
}
function dismiss(t) {
    if (!t.parentNode) return;
    t.classList.add('toast-out');
    t.addEventListener('animationend', () => t.remove(), {once:true});
}

// ─── UI Helpers ───────────────────────────────────────────────
function appendMsg(sender, text, cls) {
    const row = document.createElement('div');
    row.className = 'chat-msg-row';
    row.innerHTML = `<span class="msg-sender ${escapeHTML(cls)}">${escapeHTML(sender)}:</span> <span>${escapeHTML(text)}</span>`;
    chatBox.appendChild(row);
    if (chatBox.children.length > 120) chatBox.removeChild(chatBox.firstChild);
    chatBox.scrollTop = chatBox.scrollHeight;
}

function setLoaderMode(mode) {
    loader.setAttribute('data-mode', mode);
    const text = mode === 'waiting' ? 'Searching..' : 'Connecting..';
    loaderText.setAttribute('data-glitch', text);
    loaderText.textContent = text;
}
function showLoader(mode='loading') {
    stoppedOverlay.classList.remove('active');
    loader.style.display = 'flex';
    setLoaderMode(mode);
}
function hideLoader()  { loader.style.display = 'none'; }
function showStopped() { loader.style.display = 'none'; stoppedOverlay.classList.add('active'); }
function hideStopped() { stoppedOverlay.classList.remove('active'); }

function setPartnerLabel(nick, city) {
    document.getElementById('partner-name-display').textContent =
        nick && city ? `${sanitizeText(nick)} (${sanitizeText(city)})` : 'Partner';
}

function setButtonState(state) {
    stopBtn.dataset.state = state;
    if (state === 'start') {
        stopBtn.textContent = 'START';
        stopBtn.className = 'uiverse-btn btn-toggle start-mode';
        isStopped = true;
    } else {
        stopBtn.textContent = 'STOP';
        stopBtn.className = 'uiverse-btn btn-toggle stop-mode';
        isStopped = false;
    }
}

// ─── WebRTC core ──────────────────────────────────────────────
function cleanupPC() {
    iceCandidateQueue = [];
    isInitiatorRole = false;
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.onnegotiationneeded = null;
        try { peerConnection.close(); } catch {}
        peerConnection = null;
    }
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(t => t.stop());
        remoteVideo.srcObject = null;
    }
    hasPartner = false;
    isSearching = false;
}

function createPeerConnection() {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Add local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Send ALL ICE candidates (server will filter private ones if needed)
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
            socket.emit('signal', { ice: candidate.toJSON() });
        }
    };

    pc.onicegatheringstatechange = () => {
        console.log('[ICE gather]', pc.iceGatheringState);
    };

    // When remote track arrives → attach to video
    pc.ontrack = (e) => {
        console.log('[WebRTC] ontrack:', e.track.kind);
        if (e.streams && e.streams[0]) {
            if (remoteVideo.srcObject !== e.streams[0]) {
                remoteVideo.srcObject = e.streams[0];
                remoteVideo.play().catch(err => console.warn('[Video play]', err));
                hasPartner = true;
                hideLoader();
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[ICE state]', pc.iceConnectionState);
        switch (pc.iceConnectionState) {
            case 'connected':
            case 'completed':
                hasPartner = true;
                hideLoader();
                break;
            case 'failed':
                showToast('Connection failed — retrying...', 'warn');
                if (isInitiatorRole && pc === peerConnection) {
                    pc.restartIce();
                }
                break;
            case 'disconnected':
                showToast('Connection interrupted...', 'warn');
                break;
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[PC state]', pc.connectionState);
        if (pc.connectionState === 'failed') {
            showToast('Connection failed.', 'error');
        }
    };

    return pc;
}

// Drain queued ICE candidates after remote description is set
async function drainIceQueue() {
    while (iceCandidateQueue.length > 0) {
        const candidate = iceCandidateQueue.shift();
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
            console.warn('[ICE queue drain error]', e.message);
        }
    }
}

// ─── App init ─────────────────────────────────────────────────
async function startApp() {
    if (window.history?.replaceState) window.history.replaceState(null,'','/chat');
    sessionData = loadSession();
    if (!sessionData) { window.location.href='/'; return; }

    showLoader('loading');

    const constraints = [
        { video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'}, audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true} },
        { video:true, audio:true },
        { video:true, audio:false },
    ];

    let acquired = false;
    for (const c of constraints) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia(c);
            acquired = true;
            break;
        } catch (e) {
            console.warn('[Camera] Constraint failed:', c, e.name);
        }
    }

    if (!acquired) {
        alert('Camera and microphone access is required. Please allow permission and reload.');
        window.location.href = '/';
        return;
    }

    localVideo.srcObject = localStream;
    localVideo.play().catch(() => {});
    document.getElementById('my-name-display').textContent = sanitizeText(sessionData.nickname);
    hideLoader();
    showStopped();
    setButtonState('start');
}

function beginSearch() {
    if (!sessionData) { window.location.href='/'; return; }
    isSearching = true;
    hideStopped();
    showLoader('loading');
    socket.emit('find-partner', {
        nickname: sessionData.nickname,
        city: sessionData.city,
        myGender: sessionData.myGender,
        seekGender: sessionData.seekGender,
    });
    setPartnerLabel(null, null);
}

function stopSearch() {
    isSearching = false;
    hasPartner = false;
    cleanupPC();
    socket.emit('stop-searching');
    showStopped();
    setPartnerLabel(null, null);
}

// ─── Button throttle (no block, just 300ms debounce) ──────────
let lastBtnClick = 0;
function throttleBtn() {
    const now = Date.now();
    if (now - lastBtnClick < 300) return false;
    lastBtnClick = now;
    return true;
}

stopBtn.addEventListener('click', () => {
    if (!throttleBtn()) return;
    if (isStopped) { setButtonState('stop'); beginSearch(); }
    else           { setButtonState('start'); stopSearch(); }
});

document.getElementById('next-btn').addEventListener('click', () => {
    if (!throttleBtn()) return;
    if (isStopped) setButtonState('stop');
    cleanupPC();
    chatBox.innerHTML = '';
    beginSearch();
});

document.getElementById('report-btn').addEventListener('click', () => {
    if (!hasPartner) { showToast('You need a partner to send a report.', 'system'); return; }
    if (confirm('Are you sure you want to report this user?')) {
        socket.emit('report-user');
        showToast('Report submitted.', 'success');
    }
});

// ─── Menu FAB ─────────────────────────────────────────────────
const menuFab     = document.getElementById('menu-fab');
const menuPanel   = document.getElementById('menu-panel');
const menuOverlay = document.getElementById('menu-overlay');
const menuClose   = document.getElementById('menu-close');

function openMenu()  { menuFab.classList.add('open'); menuPanel.classList.add('open'); menuOverlay.classList.add('active'); }
function closeMenu() { menuFab.classList.remove('open'); menuPanel.classList.remove('open'); menuOverlay.classList.remove('active'); }
menuFab.addEventListener('click', () => menuPanel.classList.contains('open') ? closeMenu() : openMenu());
menuClose.addEventListener('click', closeMenu);
menuOverlay.addEventListener('click', closeMenu);

// ─── Chat ─────────────────────────────────────────────────────
function sendMsg() {
    const raw = msgInput.value.trim();
    if (!raw) return;
    if (!hasPartner) { showToast('No partner connected yet.', 'system'); return; }
    const now = Date.now();
    if (now - lastMsgTime < 200) { showToast('Typing too fast.', 'warn'); return; }
    const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g,'').trim();
    if (!cleaned || cleaned.length > 400) return;
    socket.emit('chat-msg', cleaned);
    appendMsg('You', cleaned, 'me');
    msgInput.value = '';
    lastMsgTime = now;
}
document.getElementById('send-btn').addEventListener('click', sendMsg);
msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

// ─── Socket events ────────────────────────────────────────────
socket.on('waiting', () => {
    isSearching = true;
    hasPartner = false;
    showLoader('waiting');    // shows radar animation
});

socket.on('partner-found', async (data) => {
    if (!data || typeof data.nickname !== 'string') return;

    isSearching = false;
    chatBox.innerHTML = '';
    partnerNickname = sanitizeText(data.nickname) || 'Partner';
    setPartnerLabel(data.nickname, data.city);
    showLoader('loading');

    isInitiatorRole = data.isInitiator;
    cleanupPC();
    peerConnection = createPeerConnection();

    if (data.isInitiator) {
        try {
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            });
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { sdp: { type: offer.type, sdp: offer.sdp } });
            console.log('[WebRTC] Offer sent');
        } catch (e) {
            console.error('[WebRTC] createOffer failed:', e);
            showToast('Could not start video connection.', 'error');
        }
    }
});

socket.on('signal', async (data) => {
    try {
        // Safety: create PC if missing (non-initiator may receive signal before partner-found resolves)
        if (!peerConnection) {
            console.warn('[Signal] No PC yet, creating...');
            peerConnection = createPeerConnection();
        }

        if (data?.sdp) {
            const { type, sdp } = data.sdp;
            if (!['offer','answer'].includes(type)) return;

            console.log('[Signal] SDP received:', type, '| state:', peerConnection.signalingState);

            // Guard against invalid state transitions
            if (type === 'offer' && peerConnection.signalingState !== 'stable') {
                console.warn('[Signal] Ignoring offer in state:', peerConnection.signalingState);
                return;
            }
            if (type === 'answer' && peerConnection.signalingState !== 'have-local-offer') {
                console.warn('[Signal] Ignoring answer in state:', peerConnection.signalingState);
                return;
            }

            await peerConnection.setRemoteDescription(new RTCSessionDescription({ type, sdp }));
            console.log('[Signal] Remote description set');

            // Drain any queued ICE candidates
            await drainIceQueue();

            if (type === 'offer') {
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('signal', { sdp: { type: answer.type, sdp: answer.sdp } });
                console.log('[Signal] Answer sent');
            }

        } else if (data?.ice) {
            const candidate = data.ice;
            if (peerConnection.remoteDescription) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
                // Queue until remote description arrives
                iceCandidateQueue.push(candidate);
                console.log('[ICE] Queued candidate, queue size:', iceCandidateQueue.length);
            }
        }
    } catch (e) {
        console.error('[Signal] Error:', e.message);
    }
});

socket.on('chat-msg', msg => {
    if (typeof msg !== 'string' || msg.length > 400) return;
    appendMsg(partnerNickname, msg, 'partner');
});

socket.on('update-online-count', count => {
    if (typeof count !== 'number') return;
    document.getElementById('user-count').textContent = Math.max(0, count);
});

socket.on('partner-disconnected', () => {
    showToast('Partner disconnected.', 'warn');
    cleanupPC();
    chatBox.innerHTML = '';
    partnerNickname = 'Partner';
    setPartnerLabel(null, null);
    if (!isStopped) beginSearch(); else showStopped();
});

socket.on('banned', msg => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    clearSession();
    document.body.innerHTML = '';
    document.body.style.cssText = 'display:flex;justify-content:center;align-items:center;height:100vh;background:#06060e;';
    const wrap = document.createElement('div'); wrap.style.textAlign = 'center';
    const h1 = document.createElement('h1');
    h1.style.cssText = 'color:#ef4444;margin-bottom:14px;font-size:1.7rem;font-family:Syne,sans-serif;';
    h1.textContent = '⛔ Banned';
    const p = document.createElement('p');
    p.style.cssText = 'color:rgba(255,255,255,0.45);font-family:Space Grotesk,sans-serif;font-size:0.9rem;';
    p.textContent = typeof msg === 'string' ? msg : 'You have been banned.';
    wrap.appendChild(h1); wrap.appendChild(p); document.body.appendChild(wrap);
});

socket.on('error', msg => { if (typeof msg === 'string') showToast(msg, 'error'); });

window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    cleanupPC();
    socket.disconnect();
});

startApp();