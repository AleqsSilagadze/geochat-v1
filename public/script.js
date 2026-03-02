const socket = io();
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const msgInput = document.getElementById('msg-input');
const chatBox = document.getElementById('chat-box');
const loader = document.getElementById('loader');

let localStream;
let peerConnection;
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// URL-დან მონაცემების უსაფრთხოდ ამოღება
function getSafeParam(name, maxLen) {
    const params = new URLSearchParams(window.location.search);
    const val = params.get(name) || "";
    const div = document.createElement('div');
    div.textContent = val.substring(0, maxLen);
    return div.innerHTML; // გასუფთავებული ტექსტი
}

function displayMessage(sender, text, color) {
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = "8px";
    msgDiv.innerHTML = `<b style="color:${color}">${sender}: </b><span class="txt"></span>`;
    msgDiv.querySelector('.txt').textContent = text;
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
        // ვიდეოს გამოჩენისთანავე ვაქრობთ ლოუდერს
        remoteVideo.onloadedmetadata = () => {
            loader.style.display = 'none';
        };
    };
}

async function startApp() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;

        const nickname = getSafeParam('nickname', 15) || 'სტუმარი';
        const city = getSafeParam('city', 20) || 'თბილისი';

        socket.emit('find-partner', { 
            nickname: nickname, 
            city: city,
            myGender: getSafeParam('myGender', 10),
            seekGender: getSafeParam('seekGender', 10)
        });
        
        document.getElementById('my-name-display').textContent = nickname;
    } catch (err) {
        alert("კამერაზე წვდომა აუცილებელია!");
        window.location.href = 'Registration.html';
    }
}

socket.on('partner-found', async (data) => {
    document.getElementById('partner-name-display').textContent = `${data.nickname} (${data.city})`;
    chatBox.innerHTML = "<p style='color:gray; text-align:center;'>მეწყვილე ნაპოვნია</p>";
    await initWebRTC();
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { sdp: offer });
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
        try { await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice)); } catch(e) {}
    }
});

// შეტყობინების გაგზავნის ფუნქცია
function sendMessage() {
    const text = msgInput.value.trim();
    if (text) {
        socket.emit('chat-msg', text);
        displayMessage('შენ', text, '#8a2be2');
        msgInput.value = "";
    }
}

// Enter ღილაკზე მოსმენა
msgInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

document.getElementById('send-btn').onclick = sendMessage;

socket.on('chat-msg', (msg) => displayMessage('მეწყვილე', msg, '#ccc'));

socket.on('update-online-count', (count) => {
    document.getElementById('user-count').textContent = count;
});

socket.on('partner-disconnected', () => {
    displayMessage('სისტემა', 'მეწყვილე გავიდა.', 'red');
    remoteVideo.srcObject = null;
    loader.style.display = 'flex';
    document.getElementById('partner-name-display').textContent = 'მეწყვილე';
});

socket.on('banned', (msg) => {
    document.body.innerHTML = `<h1 style="color:white; text-align:center; margin-top:20%; font-family:sans-serif;">${msg}</h1>`;
});

document.getElementById('next-btn').onclick = () => location.reload();
document.getElementById('stop-btn').onclick = () => window.location.href = 'Registration.html';
document.getElementById('report-btn').onclick = () => {
    if(confirm("ნამდვილად გსურთ რეპორტი?")) {
        socket.emit('report-user');
        location.reload();
    }
};

startApp();