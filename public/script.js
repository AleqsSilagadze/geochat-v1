const socket = io({
    reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: 5,
    transports: ['websocket'], withCredentials: false,
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
let localStream, peerConnection;
let isSearching = false, hasPartner = false, isStopped = true, lastMsgTime = 0;
let sessionData = null;

// ✅ Button rate limiting: 5 rapid clicks → 10s block
let btnPresses = 0, btnResetTimer = null, btnBlocked = false;

// ─── WebRTC ───────────────────────────────────────────────────
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceCandidatePoolSize: 3, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require',
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

// ─── UI ───────────────────────────────────────────────────────
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
    const text = mode === 'waiting' ? 'Waiting..' : 'Loading..';
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

// ✅ Rate limit: 5 clicks in 3s → block 10s
function checkBtnRateLimit() {
    if (btnBlocked) {
        showToast('Too many clicks — wait a moment.', 'warn');
        return false;
    }
    btnPresses++;
    clearTimeout(btnResetTimer);
    btnResetTimer = setTimeout(() => { btnPresses = 0; }, 3000);

    if (btnPresses >= 5) {
        btnBlocked = true;
        const prev = isStopped;
        stopBtn.className = 'uiverse-btn btn-toggle rate-limited';
        stopBtn.textContent = '⏳ Wait...';
        showToast('Slow down — button locked for 10 seconds.', 'warn');
        setTimeout(() => {
            btnBlocked = false; btnPresses = 0;
            setButtonState(prev ? 'start' : 'stop');
        }, 10000);
        return false;
    }
    return true;
}

// ─── WebRTC ───────────────────────────────────────────────────
function cleanupPC() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close(); peerConnection = null;
    }
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(t => t.stop());
        remoteVideo.srcObject = null;
    }
    hasPartner = false; isSearching = false;
}

async function initWebRTC() {
    cleanupPC();
    peerConnection = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach(t => peerConnection.addTrack(t, localStream));

    peerConnection.onicecandidate = (e) => {
        if (!e.candidate) return;
        const cand = e.candidate.candidate || '';
        if (!/192\.168\.|( 10\.)| 172\.(1[6-9]|2\d|3[01])\./.test(cand))
            socket.emit('signal', { ice: e.candidate.toJSON() });
    };
    peerConnection.ontrack = (e) => {
        if (remoteVideo.srcObject !== e.streams[0]) {
            remoteVideo.srcObject = e.streams[0]; hideLoader(); hasPartner = true;
        }
    };
    peerConnection.onconnectionstatechange = () => {
        const s = peerConnection?.connectionState;
        if (s === 'failed')       { showToast('Connection failed.','error'); showLoader('loading'); }
        if (s === 'disconnected') { showToast('Connection lost.','warn'); }
        if (s === 'connected')    { hasPartner = true; }
    };
}

// ─── App ──────────────────────────────────────────────────────
async function startApp() {
    if (window.history?.replaceState) window.history.replaceState(null,'','/chat');
    sessionData = loadSession();
    if (!sessionData) { window.location.href='/'; return; }

    showLoader('loading');
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'},
            audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
        });
        localVideo.srcObject = localStream;
        document.getElementById('my-name-display').textContent = sanitizeText(sessionData.nickname);
        hideLoader(); showStopped(); setButtonState('start');
    } catch(err) {
        let msg = 'Camera and microphone access is required!';
        if (err.name==='NotAllowedError') msg='Permission denied. Please allow camera and microphone.';
        if (err.name==='NotFoundError')   msg='No camera or microphone found.';
        alert(msg); window.location.href='/';
    }
}

function beginSearch() {
    if (!sessionData) { window.location.href='/'; return; }
    isSearching=true; hideStopped(); showLoader('loading');
    socket.emit('find-partner', {
        nickname:sessionData.nickname, city:sessionData.city,
        myGender:sessionData.myGender, seekGender:sessionData.seekGender,
    });
    setPartnerLabel(null,null);
}
function stopSearch() {
    isSearching=false; hasPartner=false; cleanupPC();
    socket.emit('stop-searching'); showStopped(); setPartnerLabel(null,null);
}

// ─── Buttons ──────────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
    if (!checkBtnRateLimit()) return;
    if (isStopped) { setButtonState('stop'); beginSearch(); }
    else           { setButtonState('start'); stopSearch(); }
});

document.getElementById('next-btn').addEventListener('click', () => {
    if (!checkBtnRateLimit()) return;
    if (isStopped) setButtonState('stop');
    cleanupPC(); chatBox.innerHTML = ''; beginSearch();
});

document.getElementById('report-btn').addEventListener('click', () => {
    if (!hasPartner) { showToast('You need a partner to send a report.','system'); return; }
    if (confirm('Are you sure you want to report this user?')) {
        socket.emit('report-user'); showToast('Report submitted.','success');
    }
});

// ─── Chat ─────────────────────────────────────────────────────
function sendMsg() {
    const raw = msgInput.value.trim();
    if (!raw) return;
    if (!hasPartner) { showToast('No partner connected yet.','system'); return; }
    const now = Date.now();
    if (now - lastMsgTime < 200) { showToast('Typing too fast.','warn'); return; }
    const cleaned = raw.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g,'').trim();
    if (!cleaned || cleaned.length > 400) return;
    socket.emit('chat-msg', cleaned);
    appendMsg('You', cleaned, 'me');
    msgInput.value = ''; lastMsgTime = now;
}
document.getElementById('send-btn').addEventListener('click', sendMsg);
msgInput.addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();} });

// ─── Socket events ────────────────────────────────────────────
socket.on('waiting', () => { isSearching=true; hasPartner=false; showLoader('waiting'); });

socket.on('partner-found', async (data) => {
    if (!data||typeof data.nickname!=='string') return;
    isSearching=false; hasPartner=true;
    chatBox.innerHTML = ''; setPartnerLabel(data.nickname, data.city); showLoader('loading');
    await initWebRTC();
    if (data.isInitiator) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { sdp:{type:offer.type,sdp:offer.sdp} });
        } catch { showToast('Could not create connection.','error'); }
    }
});

socket.on('signal', async (data) => {
    if (!peerConnection) await initWebRTC();
    try {
        if (data?.sdp) {
            if (!['offer','answer'].includes(data.sdp.type)) return;
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type==='offer') {
                const ans = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(ans);
                socket.emit('signal', { sdp:{type:ans.type,sdp:ans.sdp} });
            }
        } else if (data?.ice) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice));
        }
    } catch { /* silent */ }
});

socket.on('chat-msg', msg => {
    if (typeof msg!=='string'||msg.length>400) return;
    appendMsg('Partner', msg, 'partner');
});

socket.on('update-online-count', count => {
    if (typeof count!=='number') return;
    document.getElementById('user-count').textContent = Math.max(0,count);
});

socket.on('partner-disconnected', () => {
    showToast('Partner disconnected.','warn');
    cleanupPC(); chatBox.innerHTML=''; setPartnerLabel(null,null);
    if (!isStopped) beginSearch(); else showStopped();
});

socket.on('banned', msg => {
    if (localStream) localStream.getTracks().forEach(t=>t.stop());
    clearSession();
    document.body.innerHTML='';
    document.body.style.cssText='display:flex;justify-content:center;align-items:center;height:100vh;background:#06060e;';
    const wrap=document.createElement('div'); wrap.style.textAlign='center';
    const h1=document.createElement('h1');
    h1.style.cssText='color:#ef4444;margin-bottom:14px;font-size:1.7rem;font-family:Syne,sans-serif;';
    h1.textContent='⛔ Banned';
    const p=document.createElement('p');
    p.style.cssText='color:rgba(255,255,255,0.45);font-family:Space Grotesk,sans-serif;font-size:0.9rem;';
    p.textContent=typeof msg==='string'?msg:'You have been banned.';
    wrap.appendChild(h1); wrap.appendChild(p); document.body.appendChild(wrap);
});

socket.on('error', msg => { if(typeof msg==='string') showToast(msg,'error'); });

window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach(t=>t.stop());
    cleanupPC(); socket.disconnect();
});

startApp();