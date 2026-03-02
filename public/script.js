const socket = io();
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const msgInput = document.getElementById('msg-input');
const chatBox = document.getElementById('chat-box');
const loader = document.getElementById('loader');

let localStream;
let peerConnection;
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function displayMessage(sender, text, color) {
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = "8px";
    const nameSpan = document.createElement('b');
    nameSpan.style.color = color;
    nameSpan.textContent = sender + ": ";
    const textSpan = document.createElement('span');
    textSpan.textContent = text;

    msgDiv.appendChild(nameSpan);
    msgDiv.appendChild(textSpan);
    chatBox.appendChild(msgDiv);
    chatBox.scrollTop = chatBox.scrollHeight;
}

async function initWebRTC() {
    if (peerConnection) peerConnection.close();
    peerConnection = new RTCPeerConnection(config);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { ice: e.candidate });
    };

    peerConnection.ontrack = (e) => {
        remoteVideo.srcObject = e.streams[0];
        loader.style.display = 'none'; // კამერა ჩაირთო → loading ქრება
    };
}

async function startApp() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;

        const params = new URLSearchParams(window.location.search);
        socket.emit('find-partner', { 
            nickname: params.get('nickname') || 'სტუმარი', 
            city: params.get('city') || 'თბილისი' 
        });
        
        document.getElementById('my-name-display').textContent = params.get('nickname') || 'შენ';
    } catch (err) {
        alert("კამერაზე წვდომა აუცილებელია!");
    }
}

// ==================== PARTNER FOUND + REAL WEBRTC ====================
socket.on('partner-found', async (data) => {
    document.getElementById('partner-name-display').textContent = `${data.nickname} (${data.city})`;
    chatBox.innerHTML = "<p style='color:gray; text-align:center;'>მეწყვილე ნაპოვნია</p>";
    
    await initWebRTC();

    // მხოლოდ ინიციატორი ქმნის Offer-ს (არა ორივე მხარე!)
    if (data.isInitiator) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        socket.emit('signal', { sdp: offer });
    }
});

socket.on('signal', async (data) => {
    if (!peerConnection) await initWebRTC();
    
    if (data.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('signal', { sdp: answer });
        }
    } else if (data.ice) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice)).catch(() => {});
    }
});

// ==================== CHAT & OTHER ====================
socket.on('chat-msg', (msg) => displayMessage('მეწყვილე', msg, '#ccc'));
socket.on('update-online-count', (count) => {
    document.getElementById('user-count').textContent = count;
});
socket.on('partner-disconnected', () => {
    displayMessage('სისტემა', 'მეწყვილე გავიდა.', 'red');
    remoteVideo.srcObject = null;
    loader.style.display = 'flex';
});
socket.on('banned', (msg) => {
    document.body.innerHTML = `<h1 style="color:white; text-align:center; margin-top:20%;">${msg}</h1>`;
});

// ==================== SEND MESSAGE (Enter + Button) ====================
function sendMessage() {
    const text = msgInput.value.trim();
    if (text) {
        socket.emit('chat-msg', text);
        displayMessage('შენ', text, '#8a2be2');
        msgInput.value = "";
    }
}

document.getElementById('send-btn').onclick = sendMessage;
msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

// ==================== BUTTONS ====================
document.getElementById('next-btn').onclick = () => location.reload(); // reload → loading კვლავ ჩნდება
document.getElementById('stop-btn').onclick = () => window.location.href = 'Registration.html';
document.getElementById('report-btn').onclick = () => {
    if (confirm('ნამდვილად გსურთ ამ მეწყვილის რეპორტი?')) {
        socket.emit('report-user');
    }
};

startApp();