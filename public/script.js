const socket = io({
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 5
});

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const msgInput = document.getElementById('msg-input');
const chatBox = document.getElementById('chat-box');
const loader = document.getElementById('loader');
const loaderText = document.getElementById('loader-text'); // ✅ FIX: reference to loader text element

let localStream;
let peerConnection;
let isSearching = false;    // true = waiting in queue
let hasPartner = false;     // true = currently in a call
let messageCount = 0;
let lastMessageTime = 0;

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

function sanitizeHTML(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function displayMessage(sender, text, color) {
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = "8px";

    const nameSpan = document.createElement('b');
    nameSpan.style.color = color;
    nameSpan.textContent = sender + ": ";

    const textSpan = document.createElement('span');
    textSpan.textContent = text; // already sanitized server-side, sanitizeHTML used for our own display

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
    chatBox.appendChild(msgDiv);

    if (chatBox.children.length > 100) {
        chatBox.removeChild(chatBox.firstChild);
    }

    chatBox.scrollTop = chatBox.scrollHeight;
}

// ✅ FIX: Update loader text — "Loading.." while connecting, "Waiting.." while in queue
function setLoaderText(mode) {
    if (!loaderText) return;
    if (mode === 'loading') {
        loaderText.setAttribute('data-glitch', 'Loading..');
        loaderText.textContent = 'Loading..';
    } else if (mode === 'waiting') {
        loaderText.setAttribute('data-glitch', 'Waiting..');
        loaderText.textContent = 'Waiting..';
    }
}

function showLoader(mode = 'loading') {
    loader.style.display = 'flex';
    setLoaderText(mode);
}

function hideLoader() {
    loader.style.display = 'none';
}

function cleanupPeerConnection() {
    if (peerConnection) {
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }

    if (remoteVideo.srcObject) {
        remoteVideo.srcObject.getTracks().forEach(track => track.stop());
        remoteVideo.srcObject = null;
    }

    hasPartner = false;
}

async function initWebRTC() {
    cleanupPeerConnection();

    peerConnection = new RTCPeerConnection(config);

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('signal', { ice: e.candidate });
        }
    };

    peerConnection.ontrack = (e) => {
        if (remoteVideo.srcObject !== e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
            hideLoader();
            hasPartner = true;
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);

        if (peerConnection.connectionState === 'failed') {
            displayMessage('სისტემა', 'კავშირი ვერ დამყარდა', 'red');
            showLoader('loading');
        }

        if (peerConnection.connectionState === 'disconnected') {
            displayMessage('სისტემა', 'კავშირი გაწყდა', 'orange');
        }

        if (peerConnection.connectionState === 'connected') {
            console.log('✅ WebRTC Connected Successfully!');
            hasPartner = true;
        }
    };

    peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
    };
}

async function startApp() {
    showLoader('loading');

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        localVideo.srcObject = localStream;

        const params = new URLSearchParams(window.location.search);
        let nickname = params.get('nickname') || 'სტუმარი';
        let city = params.get('city') || 'random';
        let myGender = params.get('myGender') || 'male';
        let seekGender = params.get('seekGender') || 'female';

        nickname = nickname.trim().substring(0, 15).replace(/[^\wა-ჰ0-9]/gi, '');
        city = city.trim().substring(0, 30);

        if (nickname.length < 2) nickname = 'სტუმარი';

        document.getElementById('my-name-display').textContent = nickname;

        // ✅ Start searching — show "Loading.." while initiating
        isSearching = true;
        showLoader('loading');

        socket.emit('find-partner', { nickname, city, myGender, seekGender });

    } catch (err) {
        console.error('Media access error:', err);

        let errorMsg = "კამერაზე და მიკროფონზე წვდომა აუცილებელია!";

        if (err.name === 'NotAllowedError') {
            errorMsg = "თქვენ უარი თქვით კამერისა და მიკროფონის დაშვებაზე. გთხოვთ, მიეცით ნებართვა.";
        } else if (err.name === 'NotFoundError') {
            errorMsg = "კამერა ან მიკროფონი ვერ მოიძებნა.";
        }

        alert(errorMsg);
        window.location.href = '/';
    }
}

// ✅ FIX: Server tells us we are in the waiting queue → show "Waiting.."
socket.on('waiting', () => {
    isSearching = true;
    hasPartner = false;
    showLoader('waiting');
});

socket.on('partner-found', async (data) => {
    isSearching = false;
    hasPartner = true;

    document.getElementById('partner-name-display').textContent = `${data.nickname} (${data.city})`;
    chatBox.innerHTML = "<p style='color:gray; text-align:center;'>მეწყვილე ნაპოვნია</p>";

    // Show "Loading.." while WebRTC connects
    showLoader('loading');

    await initWebRTC();

    if (data.isInitiator) {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('signal', { sdp: offer });
        } catch (err) {
            console.error('Offer creation failed:', err);
            displayMessage('სისტემა', 'კავშირის შექმნა ვერ მოხერხდა', 'red');
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
    displayMessage('მეწყვილე', msg, '#00bcd4');
});

socket.on('update-online-count', (count) => {
    document.getElementById('user-count').textContent = count;
});

socket.on('partner-disconnected', () => {
    displayMessage('სისტემა', 'მეწყვილე გავიდა.', '#ff5252');
    cleanupPeerConnection();
    document.getElementById('partner-name-display').textContent = 'მეწყვილე';

    // Automatically search for next partner
    const params = new URLSearchParams(window.location.search);
    isSearching = true;
    showLoader('loading');
    socket.emit('find-partner', {
        nickname: params.get('nickname') || 'სტუმარი',
        city: params.get('city') || 'random',
        myGender: params.get('myGender') || 'male',
        seekGender: params.get('seekGender') || 'female'
    });
});

socket.on('banned', (msg) => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    document.body.innerHTML = `
        <div style="display:flex; justify-content:center; align-items:center; height:100vh; background:#1a1a2e;">
            <div style="text-align:center; color:white;">
                <h1 style="color:#ff5252; margin-bottom:20px;">⛔ დაბლოკილი</h1>
                <p style="font-size:18px;">${sanitizeHTML(msg)}</p>
            </div>
        </div>
    `;
});

socket.on('error', (msg) => {
    displayMessage('სისტემა', msg, '#ff9800');
});

function sendMessage() {
    const text = msgInput.value.trim();

    if (!text) return;

    if (!hasPartner) {
        displayMessage('სისტემა', 'ჯერ მეწყვილე არ გყავს', '#ff9800');
        return;
    }

    const now = Date.now();
    if (now - lastMessageTime < 200) {
        displayMessage('სისტემა', 'ძალიან სწრაფად აკრიფავთ', '#ff9800');
        return;
    }

    if (text.length > 400) {
        displayMessage('სისტემა', 'შეტყობინება ძალიან გრძელია', '#ff9800');
        return;
    }

    socket.emit('chat-msg', text);
    displayMessage('შენ', text, '#8a2be2');
    msgInput.value = "";
    lastMessageTime = now;
    messageCount++;
}

document.getElementById('send-btn').onclick = sendMessage;

msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// ✅ FIX: Next button — find new partner
document.getElementById('next-btn').onclick = () => {
    cleanupPeerConnection();
    chatBox.innerHTML = "";
    document.getElementById('partner-name-display').textContent = 'მეწყვილე';
    isSearching = true;
    showLoader('loading');

    const params = new URLSearchParams(window.location.search);
    socket.emit('find-partner', {
        nickname: params.get('nickname') || 'სტუმარი',
        city: params.get('city') || 'random',
        myGender: params.get('myGender') || 'male',
        seekGender: params.get('seekGender') || 'female'
    });
};

// ✅ FIX: Stop button — stop searching / pause, show "Waiting.." is OFF, go back to registration
// Logic: if searching → stop search (show stopped state). if in call → end call, go home.
document.getElementById('stop-btn').onclick = () => {
    if (isSearching) {
        // Currently waiting in queue — stop searching
        isSearching = false;
        socket.emit('stop-searching');
        hideLoader();
        displayMessage('სისტემა', 'ძიება შეჩერებულია. "შემდეგი" დააჭირე ახლიდან დასაწყებად.', '#aaaaaa');
    } else if (hasPartner) {
        // In an active call — end call and go to registration
        cleanupPeerConnection();
        socket.emit('stop-searching');
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        window.location.href = '/';
    } else {
        // Idle state — just go home
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        window.location.href = '/';
    }
};

document.getElementById('report-btn').onclick = () => {
    if (!hasPartner) {
        displayMessage('სისტემა', 'რეპორტისთვის ჯერ მეწყვილე უნდა გყავდეს', '#ff9800');
        return;
    }
    if (confirm('ნამდვილად გსურთ ამ მომხმარებლის რეპორტი?')) {
        socket.emit('report-user');
        displayMessage('სისტემა', 'რეპორტი გაგზავნილია', '#4caf50');
    }
};

window.addEventListener('beforeunload', () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    cleanupPeerConnection();
});

startApp();