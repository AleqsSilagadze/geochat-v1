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
        const vipCode = typeof data.vipCode === 'string' ? data.vipCode.toUpperCase().trim() : '';
        return { nickname: nick, city, myGender, seekGender, vipCode };
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

function setPartnerLabel(nick, city, isVip) {
    const el = document.getElementById('partner-name-display');
    if (nick && city) {
        el.innerHTML = '';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = sanitizeText(nick) + ' (' + sanitizeText(city) + ')';
        el.appendChild(nameSpan);
        if (isVip) {
            const badge = document.createElement('span');
            badge.className = 'vip-name-badge';
            badge.textContent = '💎 VIP';
            el.appendChild(badge);
        }
    } else {
        el.innerHTML = '';
        el.textContent = 'Partner';
    }
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
    window.gcHasPartner = false;
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
                window.gcHasPartner = true;
                hideLoader();
                // Start AI nudity scanning
                setTimeout(() => startNSFWScan(), 2000);
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log('[ICE state]', pc.iceConnectionState);
        switch (pc.iceConnectionState) {
            case 'connected':
            case 'completed':
                hasPartner = true;
                window.gcHasPartner = true;
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

// ─── NSFWJS AI Nudity Detection (free, runs in browser) ──────
let nsfwModel = null;
let nsfwScanInterval = null;
let lastNsfwAlert = 0;

async function loadNSFWModel() {
    try {
        if (typeof nsfwjs === 'undefined') return;
        nsfwModel = await nsfwjs.load('https://nsfwjs.com/quant_nsfw_mobilenet/', { size: 224 });
        console.log('[AI] NSFW model loaded ✅');
    } catch(e) {
        console.warn('[AI] NSFW model load failed:', e.message);
    }
}

async function scanVideoForNudity(videoEl) {
    if (!nsfwModel || !videoEl || videoEl.readyState < 2) return null;
    try {
        const predictions = await nsfwModel.classify(videoEl);
        const nudityScore = predictions.find(p => p.className === 'Porn')?.probability || 0;
        const hentaiScore = predictions.find(p => p.className === 'Hentai')?.probability || 0;
        const sexyScore   = predictions.find(p => p.className === 'Sexy')?.probability || 0;
        return { nudityScore, hentaiScore, sexyScore, total: nudityScore + hentaiScore * 0.8 + sexyScore * 0.3 };
    } catch { return null; }
}

function startNSFWScan() {
    if (!nsfwModel) return;
    stopNSFWScan();
    nsfwScanInterval = setInterval(async () => {
        if (!hasPartner) return;
        const result = await scanVideoForNudity(remoteVideo);
        if (!result) return;
        const now = Date.now();
        // Auto-report threshold: nudity > 70% confidence
        if (result.total > 0.70 && now - lastNsfwAlert > 15000) {
            lastNsfwAlert = now;
            console.warn('[AI] Nudity detected! Score:', result.total.toFixed(2));
            showToast('🤖 AI-მ ამოიცნო სიშიშვლე — ავტომატური რეპორტი გაიგზავნა', 'error');
            socket.emit('report-user', { reason: 'ai_nudity', aiScore: Math.round(result.total * 100) });
        }
    }, 3000); // scan every 3 seconds
}

function stopNSFWScan() {
    if (nsfwScanInterval) { clearInterval(nsfwScanInterval); nsfwScanInterval = null; }
}

// Load NSFW model on page load
loadNSFWModel();

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
        vipCode:  sessionData.vipCode || '',
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
    if (!hasPartner) { showToast('რეპორტისთვის საჭიროა პარტნიორი.', 'system'); return; }
    showReportModal();
});

function showReportModal() {
    const existing = document.getElementById('report-modal-overlay');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'report-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
        <div style="background:rgba(8,8,18,0.97);border:1px solid rgba(239,68,68,0.3);border-radius:18px;padding:28px 26px 24px;max-width:340px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.8);">
            <div style="font-size:2.4rem;margin-bottom:10px;">🚩</div>
            <h3 style="color:#fca5a5;font-size:1.1rem;font-weight:800;margin-bottom:8px;font-family:'Space Grotesk',sans-serif;">რეპორტი</h3>
            <p style="color:rgba(255,255,255,0.5);font-size:0.8rem;line-height:1.55;margin-bottom:6px;font-family:'Space Grotesk',sans-serif;">
                დარღვევის სახე:
            </p>
            <div id="report-reason-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;text-align:left;">
                ${['🔞 სიშიშვლე / სექსუალური კონტენტი','🤬 შეურაცხყოფა / სიძულვილი','🔗 სპამი / რეკლამა','🔫 სხვა'].map((r,i)=>`
                    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:9px 12px;border-radius:9px;border:1.5px solid rgba(255,255,255,0.07);background:rgba(255,255,255,0.03);transition:background .12s;" onmouseover="this.style.background='rgba(124,58,237,0.12)'" onmouseout="this.style.background='rgba(255,255,255,0.03)'">
                        <input type="radio" name="report-reason" value="${i}" style="accent-color:#a78bfa;">
                        <span style="color:rgba(255,255,255,0.75);font-size:0.79rem;font-family:'Space Grotesk',sans-serif;">${r}</span>
                    </label>`).join('')}
            </div>
            <p style="color:rgba(255,255,255,0.3);font-size:0.7rem;margin-bottom:14px;font-family:'Space Grotesk',sans-serif;">
                🤖 სიშიშვლის ამოცნობა ხდება AI-ის დახმარებით ავტომატურად
            </p>
            <div style="display:flex;gap:8px;">
                <button id="report-cancel-btn" style="flex:1;padding:11px;border-radius:9px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.5);cursor:pointer;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;">გაუქმება</button>
                <button id="report-submit-btn" style="flex:1;padding:11px;border-radius:9px;border:none;background:linear-gradient(135deg,#dc2626,#ef4444);color:#fff;cursor:pointer;font-weight:700;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;box-shadow:0 3px 12px rgba(239,68,68,0.3);">გაგზავნა 🚩</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById('report-cancel-btn').onclick = () => overlay.remove();
    document.getElementById('report-submit-btn').onclick = async () => {
        const sel = document.querySelector('input[name="report-reason"]:checked');
        if (!sel) { showToast('გთხოვ აირჩიე დარღვევის სახე', 'warn'); return; }
        
        const submitBtn = document.getElementById('report-submit-btn');
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ გაგზავნა...';
        
        let aiScore = null;
        // Run AI scan before submitting if nudity reason selected
        if (sel.value === '0' && nsfwModel) {
            const result = await scanVideoForNudity(remoteVideo);
            if (result) aiScore = Math.round(result.total * 100);
        }
        
        socket.emit('report-user', { reason: sel.value, aiScore });
        overlay.remove();
        const aiNote = aiScore !== null ? ` (AI სქორი: ${aiScore}%)` : '';
        showToast('რეპორტი გაგზავნილია. მადლობა!' + aiNote, 'success');
    };
}


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
    setPartnerLabel(data.nickname, data.city, data.partnerIsVip);
    window.gcHasPartner = true;
    showLoader('loading');

    isInitiatorRole = data.isInitiator;
    window.gcIsInitiator = data.isInitiator;
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
    appendMsg('Partner', msg, 'partner');
});

socket.on('update-online-count', count => {
    if (typeof count !== 'number') return;
    document.getElementById('user-count').textContent = Math.max(0, count);
});

socket.on('partner-disconnected', () => {
    if (typeof Questions !== 'undefined') Questions.setSock(socket);
    showToast('Partner disconnected.', 'warn');
    cleanupPC();
    chatBox.innerHTML = '';
    setPartnerLabel(null, null);
    if (!isStopped) beginSearch(); else showStopped();
});


// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ⏱️ IP FREE TIME LIMIT — 1 საათი, header badge-ი
// ══════════════════════════════════════════════════════════════
let _freeTimerInterval = null;
let _freeSecondsLeft   = 0;

function _startFreeCountdown(remainingMs) {
    _freeSecondsLeft = Math.floor(remainingMs / 1000);
    _updateHeaderBadge();
    if (_freeTimerInterval) clearInterval(_freeTimerInterval);
    _freeTimerInterval = setInterval(() => {
        _freeSecondsLeft--;
        _updateHeaderBadge();
        if (_freeSecondsLeft <= 0) {
            clearInterval(_freeTimerInterval);
            _freeTimerInterval = null;
            _showTimeLimitScreen();
        }
    }, 1000);
}

function _fmt(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    return m + ':' + String(s).padStart(2,'0');
}

function _updateHeaderBadge() {
    const btn      = document.getElementById('vip-timer-btn');
    const display  = document.getElementById('vip-timer-display');
    const label    = btn ? btn.querySelector('.vip-timer-label') : null;
    if (!btn || !display) return;

    const isLow = _freeSecondsLeft <= 600; // 10 წუთი
    display.textContent = _fmt(_freeSecondsLeft);

    if (isLow) {
        btn.classList.add('warn');
        if (label) label.textContent = '⚠️ დრო:';
    } else {
        btn.classList.remove('warn');
        if (label) label.textContent = 'უფასო';
    }
}

function _setVipBadge() {
    const btn     = document.getElementById('vip-timer-btn');
    const display = document.getElementById('vip-timer-display');
    const label   = btn ? btn.querySelector('.vip-timer-label') : null;
    const icon    = btn ? btn.querySelector('.vip-timer-icon') : null;
    if (!btn) return;
    btn.classList.add('is-vip');
    btn.classList.remove('warn');
    if (icon)    icon.textContent    = '💎';
    if (label)   label.textContent   = 'VIP';
    if (display) display.textContent = '∞';
    if (_freeTimerInterval) { clearInterval(_freeTimerInterval); _freeTimerInterval = null; }
}

function _showTimeLimitScreen() {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (typeof socket !== 'undefined') socket.disconnect();

    document.body.innerHTML = '';
    document.body.style.cssText = [
        'display:flex', 'justify-content:center', 'align-items:center',
        'min-height:100vh', 'background:#06060e',
        'font-family:Space Grotesk,sans-serif'
    ].join(';');

    document.body.innerHTML = `
    <div style="text-align:center;max-width:400px;padding:40px 28px;">
        <div style="font-size:3.5rem;margin-bottom:20px;">⏰</div>
        <h1 style="font-family:Syne,sans-serif;font-size:1.7rem;color:#fff;margin-bottom:12px;font-weight:800;">
            უფასო ლიმიტი ამოიწურა
        </h1>
        <p style="color:rgba(255,255,255,0.45);font-size:0.9rem;line-height:1.7;margin-bottom:32px;">
            1 საათიანი უფასო პერიოდი დასრულდა.<br>
            ულიმიტო გამოყენებისთვის გადადი VIP-ზე.
        </p>
        <a href="/upgrade" style="
            display:block;padding:16px;
            background:linear-gradient(135deg,#7c3aed,#a855f7);
            border-radius:16px;color:#fff;font-weight:800;font-size:1.05rem;
            font-family:Syne,sans-serif;text-decoration:none;margin-bottom:14px;
            box-shadow:0 6px 28px rgba(124,58,237,0.4);
            transition:transform .15s,box-shadow .15s;
        " onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 10px 36px rgba(124,58,237,0.5)'"
           onmouseout="this.style.transform='';this.style.boxShadow='0 6px 28px rgba(124,58,237,0.4)'">
            💎 VIP — მხოლოდ 10 ლარი/თვეში
        </a>
        <a href="/" style="display:block;padding:10px;color:rgba(255,255,255,0.28);font-size:0.8rem;text-decoration:none;">
            ← მთავარ გვერდზე დაბრუნება
        </a>
    </div>`;
}

socket.on('time-limit-reached', () => { _showTimeLimitScreen(); });

// ── დრო სერვერიდან ─────────────────────────────────────────────
(async function _fetchTimeStatus() {
    try {
        const raw  = sessionStorage.getItem('gc_session');
        const code = raw ? (JSON.parse(raw).vipCode || '') : '';
        const r    = await fetch('/api/time-status?vip=' + encodeURIComponent(code));
        const d    = await r.json();
        if (d.isVip) { _setVipBadge(); return; }
        if (d.limitReached) { _showTimeLimitScreen(); return; }
        _startFreeCountdown(d.remainingMs);
    } catch(e) { /* silent — badge stays as default */ }
})();


// 💎 VIP badge click → პირდაპირ /upgrade გვერდი
(function() {
    var btn = document.getElementById('vip-timer-btn');
    if (!btn) return;
    btn.addEventListener('click', function() {
        window.location.href = '/upgrade';
    });
})();

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

// ── Questions socket events ────────────────────────────────────
socket.on('question-sync',   (d) => { if (typeof Questions !== 'undefined') Questions.onQuestionSync(d); });
socket.on('question-answer', (d) => { if (typeof Questions !== 'undefined') Questions.onPartnerAnswer(d); });

// Wire Questions module to socket
if (typeof Questions !== 'undefined') Questions.setSock(socket);

window.addEventListener('beforeunload', () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    cleanupPC();
    socket.disconnect();
});

startApp();

// Expose globals for games.js
window.gcSocket = socket;
window.gcHasPartner = false;
window.gcIsInitiator = false;