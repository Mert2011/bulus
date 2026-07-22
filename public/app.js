/* =========================================================================
   PocketMeet — client
   Mesh WebRTC (up to ~8 people), E2E-encrypted media + data-channel chat,
   robust device handling, screen share, virtual background, voice changer.
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const state = {
  ws: null,
  myId: null,
  myName: 'Guest',
  room: null,
  pcs: new Map(),        // peerId -> RTCPeerConnection
  dcs: new Map(),        // peerId -> RTCDataChannel
  names: new Map(),      // peerId -> name

  rawVideoTrack: null,   // real camera
  rawAudioTrack: null,   // real mic
  blankVideoTrack: null, // fallback when no camera
  silentAudioTrack: null,// fallback when no mic
  outStream: null,       // what we actually send (1 video + 1 audio)

  camOn: true,
  micOn: true,
  screenTrack: null,     // active screen-share track
  bgMode: 'none',        // none | blur | office | space | beach
  voiceMode: 'none',     // none | deep | chipmunk | robot

  seg: null, segCanvas: null, segCtx: null, segVideo: null, segTrack: null, segRunning: false,
  audioCtx: null, jungle: null,
};

/* ------------------------------- helpers ------------------------------- */
function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

function makePassword() {
  const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing chars
  const buf = new Uint32Array(12);
  crypto.getRandomValues(buf);
  const chars = [...buf].map((n) => alpha[n % alpha.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

/* ---------------------------- fallback tracks -------------------------- */
// A silent audio track so every peer connection always has an audio sender.
function makeSilentAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain).connect(dst);
  osc.start();
  const track = dst.stream.getAudioTracks()[0];
  track.enabled = false;
  return track;
}
// A black video track so every peer connection always has a video sender.
function makeBlankVideo() {
  const c = document.createElement('canvas');
  c.width = 640; c.height = 360;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d1017'; ctx.fillRect(0, 0, c.width, c.height);
  // keep it alive with a tiny repaint
  setInterval(() => { ctx.fillStyle = '#0d1017'; ctx.fillRect(0, 0, c.width, c.height); }, 1000);
  return c.captureStream(1).getVideoTracks()[0];
}

/* ------------------------------ get media ------------------------------ */
async function initMedia() {
  // Try full A/V, then degrade gracefully. Nothing here should throw fatally.
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    // Retry audio-only, then nothing.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      toast('Kamera açılamadı — sadece sesle katılıyorsun.');
    } catch (e2) {
      toast('Kamera/mikrofon yok — izleyici olarak katılıyorsun.');
    }
  }

  state.rawVideoTrack = stream?.getVideoTracks()[0] || null;
  state.rawAudioTrack = stream?.getAudioTracks()[0] || null;

  if (!state.rawVideoTrack) { state.blankVideoTrack = makeBlankVideo(); state.camOn = false; }
  if (!state.rawAudioTrack) { state.silentAudioTrack = makeSilentAudio(); state.micOn = false; }

  rebuildOutput();
  refreshDeviceList();
}

// Compose the single video + single audio track we send to everyone.
function rebuildOutput() {
  const v = currentVideoTrack();
  const a = currentAudioTrack();
  state.outStream = new MediaStream([v, a].filter(Boolean));
  showSelfTile(v);
  updateControlUI();
}

function currentVideoTrack() {
  if (state.screenTrack) return state.screenTrack;
  if (state.segTrack) return state.segTrack;
  return state.rawVideoTrack || state.blankVideoTrack;
}
function currentAudioTrack() {
  return state.rawAudioTrack || state.silentAudioTrack;
}

/* --------------------------- signaling / WS ---------------------------- */
function connectWS() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    state.ws = ws;
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws-error'));
    ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
    ws.onclose = () => setNet('bağlantı kapandı');
  });
}

function wsSend(obj) { state.ws?.readyState === 1 && state.ws.send(JSON.stringify(obj)); }
function signalTo(id, data) { wsSend({ type: 'signal', to: id, data }); }

async function handleSignal(msg) {
  switch (msg.type) {
    case 'joined':
      state.myId = msg.self.id;
      setNet(`bağlı • ${msg.peers.length + 1} kişi`);
      // We are the newcomer → we create offers to everyone already here.
      for (const p of msg.peers) {
        state.names.set(p.id, p.name);
        await createPeer(p.id, true);
      }
      break;

    case 'peer-joined':
      state.names.set(msg.id, msg.name);
      // Existing peer: prepare a connection and wait for their offer.
      await createPeer(msg.id, false);
      addSysMsg(`${msg.name} katıldı`);
      break;

    case 'peer-left':
      teardownPeer(msg.id);
      addSysMsg(`${state.names.get(msg.id) || 'Biri'} ayrıldı`);
      state.names.delete(msg.id);
      break;

    case 'signal':
      await onSignal(msg.from, msg.data);
      break;

    case 'error':
      if (msg.error === 'room-full') toast('Oda dolu (en fazla 8 kişi).');
      break;
  }
  updateNetCount();
}

/* ------------------------------ peer setup ----------------------------- */
async function createPeer(id, isInitiator) {
  if (state.pcs.has(id)) return state.pcs.get(id);
  const pc = new RTCPeerConnection(ICE);
  pc._pending = [];
  state.pcs.set(id, pc);

  // Always send our current video + audio tracks.
  for (const track of state.outStream.getTracks()) pc.addTrack(track, state.outStream);

  pc.onicecandidate = (e) => { if (e.candidate) signalTo(id, { candidate: e.candidate }); };
  pc.ontrack = (e) => attachRemote(id, e.streams[0]);
  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      // Leave the tile; peer-left will clean up fully.
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('chat');
    setupDataChannel(id, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalTo(id, { sdp: pc.localDescription });
  } else {
    pc.ondatachannel = (e) => setupDataChannel(id, e.channel);
  }
  return pc;
}

async function onSignal(from, data) {
  let pc = state.pcs.get(from);
  if (!pc) pc = await createPeer(from, false);

  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    // flush queued ICE candidates
    for (const c of pc._pending) { try { await pc.addIceCandidate(c); } catch {} }
    pc._pending = [];
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signalTo(from, { sdp: pc.localDescription });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try { await pc.addIceCandidate(data.candidate); } catch {}
    } else {
      pc._pending.push(data.candidate);
    }
  }
}

function teardownPeer(id) {
  const pc = state.pcs.get(id);
  if (pc) { try { pc.close(); } catch {} }
  state.pcs.delete(id);
  state.dcs.delete(id);
  document.getElementById(`tile-${id}`)?.remove();
}

/* ------------------------------ data channel --------------------------- */
function setupDataChannel(id, dc) {
  state.dcs.set(id, dc);
  dc.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.t === 'chat') addChatMsg(state.names.get(id) || 'Biri', m.text, false);
      if (m.t === 'meta') updateTileMeta(id, m);
    } catch {}
  };
}

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const dc of state.dcs.values()) if (dc.readyState === 'open') dc.send(raw);
}

/* -------------------------------- tiles -------------------------------- */
function showSelfTile(track) {
  let tile = $('tile-self');
  if (!tile) {
    tile = document.createElement('div');
    tile.id = 'tile-self';
    tile.className = 'tile self';
    tile.innerHTML = `
      <video autoplay playsinline muted></video>
      <div class="cam-off">📷</div>
      <div class="label"><span class="mic"></span><span>${escapeHtml(state.myName)} (sen)</span></div>`;
    $('videoGrid').appendChild(tile);
  }
  const v = tile.querySelector('video');
  v.srcObject = new MediaStream([track].filter(Boolean));
  tile.classList.toggle('cam-off', !isVideoLive());
}

function attachRemote(id, stream) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.id = `tile-${id}`;
    tile.className = 'tile';
    tile.innerHTML = `
      <video autoplay playsinline></video>
      <div class="cam-off">📷</div>
      <div class="label"><span class="mic"></span><span>${escapeHtml(state.names.get(id) || 'Misafir')}</span></div>`;
    $('videoGrid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  watchSpeaking(id, stream, tile);
}

function updateTileMeta(id, m) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  tile.classList.toggle('cam-off', m.cam === false);
  const mic = tile.querySelector('.mic');
  if (mic) mic.textContent = m.mic === false ? '🔇' : '';
}

// Highlight the tile of whoever is talking.
function watchSpeaking(id, stream, tile) {
  if (!stream.getAudioTracks().length) return;
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser(); an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const loop = () => {
      if (!document.getElementById(`tile-${id}`)) { ac.close(); return; }
      an.getByteFrequencyData(data);
      const vol = data.reduce((a, b) => a + b, 0) / data.length;
      tile.classList.toggle('speaking', vol > 18);
      requestAnimationFrame(loop);
    };
    loop();
  } catch {}
}

/* ---------------------------- track swapping --------------------------- */
async function replaceOutgoing(kind, track) {
  for (const pc of state.pcs.values()) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
    if (sender) { try { await sender.replaceTrack(track); } catch {} }
  }
}

async function updateVideoOutput() {
  const track = currentVideoTrack();
  await replaceOutgoing('video', track);
  showSelfTile(track);
  broadcast({ t: 'meta', cam: isVideoLive(), mic: state.micOn });
}
async function updateAudioOutput() {
  await replaceOutgoing('audio', currentAudioTrack());
}

function isVideoLive() {
  if (state.screenTrack) return true;
  if (state.segTrack) return true;
  return !!(state.rawVideoTrack && state.camOn);
}

/* ------------------------------ controls ------------------------------- */
function toggleMic() {
  if (!state.rawAudioTrack) return toast('Mikrofon yok.');
  state.micOn = !state.micOn;
  state.rawAudioTrack.enabled = state.micOn;
  if (state.silentAudioTrack) state.silentAudioTrack.enabled = false;
  updateControlUI();
  broadcast({ t: 'meta', cam: isVideoLive(), mic: state.micOn });
}

function toggleCam() {
  if (!state.rawVideoTrack) return toast('Kamera yok.');
  state.camOn = !state.camOn;
  state.rawVideoTrack.enabled = state.camOn;
  // If a virtual background is running off the camera, its output follows enabled state.
  $('tile-self')?.classList.toggle('cam-off', !isVideoLive());
  updateControlUI();
  updateVideoOutput();
}

async function toggleScreen() {
  if (state.screenTrack) {
    // stop sharing
    state.screenTrack.stop();
    state.screenTrack = null;
    await updateVideoOutput();
    updateControlUI();
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = s.getVideoTracks()[0];
    state.screenTrack = track;
    track.onended = async () => { state.screenTrack = null; await updateVideoOutput(); updateControlUI(); };
    await updateVideoOutput();
    updateControlUI();
  } catch { /* user cancelled */ }
}

function updateControlUI() {
  $('micBtn').classList.toggle('off', !state.micOn);
  $('camBtn').classList.toggle('off', !state.camOn && !state.screenTrack && !state.segTrack);
  $('screenBtn').classList.toggle('active', !!state.screenTrack);
  $('bgBtn').classList.toggle('active', state.bgMode !== 'none');
  $('voiceBtn').classList.toggle('active', state.voiceMode !== 'none');
  const selfMic = $('tile-self')?.querySelector('.mic');
  if (selfMic) selfMic.textContent = state.micOn ? '' : '🔇';
}

/* --------------------------- virtual background ------------------------ */
const BG_IMAGES = {
  office: makeGradient('#3a4a6b', '#1b2233', 'Ofis'),
  space:  makeGradient('#0b0b2a', '#241b4a', '✦ Uzay'),
  beach:  makeGradient('#f8d38a', '#4bb3d4', 'Sahil'),
};
function makeGradient(a, b, label) {
  const c = document.createElement('canvas'); c.width = 640; c.height = 360;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 640, 360);
  g.addColorStop(0, a); g.addColorStop(1, b);
  x.fillStyle = g; x.fillRect(0, 0, 640, 360);
  x.fillStyle = 'rgba(255,255,255,.15)'; x.font = 'bold 40px sans-serif';
  x.fillText(label, 30, 330);
  const img = new Image(); img.src = c.toDataURL();
  return img;
}

async function setBackground(mode) {
  if (mode === 'none') {
    stopSegmentation();
    state.bgMode = 'none';
    await updateVideoOutput();
    markSel('bgMenu', 'bg', 'none');
    updateControlUI();
    return;
  }
  if (!window.SelfieSegmentation) {
    $('bgNote').textContent = 'Arka plan kütüphanesi yüklenemedi (internet gerekli).';
    toast('Arka plan efekti kullanılamıyor.');
    return;
  }
  if (!state.rawVideoTrack) { toast('Arka plan için kamera gerekli.'); return; }

  state.bgMode = mode;
  markSel('bgMenu', 'bg', mode);
  await startSegmentation();
  updateControlUI();
}

async function startSegmentation() {
  if (!state.segCanvas) {
    state.segCanvas = document.createElement('canvas');
    state.segCanvas.width = 640; state.segCanvas.height = 360;
    state.segCtx = state.segCanvas.getContext('2d');
    state.segVideo = document.createElement('video');
    state.segVideo.muted = true; state.segVideo.playsInline = true;
  }
  state.segVideo.srcObject = new MediaStream([state.rawVideoTrack]);
  await state.segVideo.play().catch(() => {});

  if (!state.seg) {
    state.seg = new SelfieSegmentation({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`,
    });
    state.seg.setOptions({ modelSelection: 1 });
    state.seg.onResults(onSegResults);
  }

  if (!state.segTrack) state.segTrack = state.segCanvas.captureStream(30).getVideoTracks()[0];

  state.segRunning = true;
  pumpSegmentation();
  await updateVideoOutput();
}

async function pumpSegmentation() {
  if (!state.segRunning) return;
  try { await state.seg.send({ image: state.segVideo }); } catch {}
  if (state.segRunning) requestAnimationFrame(pumpSegmentation);
}

function onSegResults(results) {
  const ctx = state.segCtx, W = state.segCanvas.width, H = state.segCanvas.height;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  // Draw the person mask, then keep only the person pixels.
  ctx.drawImage(results.segmentationMask, 0, 0, W, H);
  ctx.globalCompositeOperation = 'source-in';
  ctx.drawImage(results.image, 0, 0, W, H);
  // Put the background behind the person.
  ctx.globalCompositeOperation = 'destination-over';
  if (state.bgMode === 'blur') {
    ctx.filter = 'blur(14px)';
    ctx.drawImage(results.image, 0, 0, W, H);
    ctx.filter = 'none';
  } else {
    const img = BG_IMAGES[state.bgMode];
    if (img && img.complete) ctx.drawImage(img, 0, 0, W, H);
    else { ctx.fillStyle = '#1b2233'; ctx.fillRect(0, 0, W, H); }
  }
  ctx.restore();
}

function stopSegmentation() {
  state.segRunning = false;
  if (state.segTrack) { state.segTrack.stop(); state.segTrack = null; }
}

/* ------------------------------ voice changer -------------------------- */
// Pitch shifter based on Chris Wilson's "Jungle" (two cross-faded delay lines).
function Jungle(context) {
  this.context = context;
  const input = context.createGain();
  const output = context.createGain();

  const mod1 = context.createBufferSource();
  const mod2 = context.createBufferSource();
  const mod3 = context.createBufferSource();
  const mod4 = context.createBufferSource();
  const fadeBuffer = createFadeBuffer(context, 0.1, 0.05);
  const shiftDownBuffer = createDelayTimeBuffer(context, 0.1, 0.05, false);
  const shiftUpBuffer = createDelayTimeBuffer(context, 0.1, 0.05, true);
  mod1.buffer = shiftDownBuffer; mod2.buffer = shiftDownBuffer;
  mod3.buffer = fadeBuffer;      mod4.buffer = fadeBuffer;
  mod1.loop = mod2.loop = mod3.loop = mod4.loop = true;

  const mod1Gain = context.createGain();
  const mod2Gain = context.createGain();
  const mod3Gain = context.createGain(); mod3Gain.gain.value = 0;
  const mod4Gain = context.createGain(); mod4Gain.gain.value = 0;

  mod1.connect(mod1Gain); mod2.connect(mod2Gain);
  mod3.connect(mod3Gain); mod4.connect(mod4Gain);

  const modGain1 = context.createGain();
  const modGain2 = context.createGain();
  const delay1 = context.createDelay(); const delay2 = context.createDelay();
  mod1Gain.connect(modGain1); mod2Gain.connect(modGain2);
  modGain1.connect(delay1.delayTime); modGain2.connect(delay2.delayTime);

  input.connect(delay1); input.connect(delay2);
  delay1.connect(mod3Gain); delay2.connect(mod4Gain);
  mod3Gain.connect(output); mod4Gain.connect(output);

  mod1.start(0); mod2.start(0.05); mod3.start(0); mod4.start(0.05);

  this.input = input; this.output = output;
  this.modGain1 = modGain1; this.modGain2 = modGain2;
  this.setPitchOffset = (mult) => {
    const t = this.context.currentTime;
    this.modGain1.gain.setTargetAtTime(0.5 * mult, t, 0.01);
    this.modGain2.gain.setTargetAtTime(0.5 * mult, t, 0.01);
  };
}
function createFadeBuffer(ctx, active, fade) {
  const rate = ctx.sampleRate, len1 = active * rate, len2 = (active - 2 * fade) * rate;
  const length = len1 + len2, buf = ctx.createBuffer(1, length, rate), p = buf.getChannelData(0);
  const fl = fade * rate, fi1 = fl, fi2 = len1 - fl;
  for (let i = 0; i < len1; i++) {
    p[i] = i < fi1 ? Math.sqrt(i / fl) : i >= fi2 ? Math.sqrt(1 - (i - fi2) / fl) : 1;
  }
  for (let i = len1; i < length; i++) p[i] = 0;
  return buf;
}
function createDelayTimeBuffer(ctx, active, fade, up) {
  const rate = ctx.sampleRate, len1 = active * rate, len2 = (active - 2 * fade) * rate;
  const length = len1 + len2, buf = ctx.createBuffer(1, length, rate), p = buf.getChannelData(0);
  for (let i = 0; i < len1; i++) p[i] = up ? (len1 - i) / length : i / len1;
  for (let i = len1; i < length; i++) p[i] = 0;
  return buf;
}

async function setVoice(mode) {
  markSel('voiceMenu', 'v', mode);
  state.voiceMode = mode;

  if (!state.rawAudioTrack) { toast('Mikrofon yok.'); return; }

  if (mode === 'none') {
    // Bypass processing: send the raw mic again.
    if (state.audioCtx) { try { state.audioCtx.close(); } catch {} state.audioCtx = null; state.jungle = null; }
    await replaceOutgoing('audio', currentAudioTrack());
    updateControlUI();
    return;
  }

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const src = ctx.createMediaStreamSource(new MediaStream([state.rawAudioTrack]));
    const dst = ctx.createMediaStreamDestination();

    if (mode === 'robot') {
      // Ring modulation → metallic robot voice.
      const osc = ctx.createOscillator(); osc.frequency.value = 50;
      const ring = ctx.createGain(); ring.gain.value = 0;
      osc.connect(ring.gain); osc.start();
      src.connect(ring); ring.connect(dst);
    } else {
      const jungle = new Jungle(ctx);
      jungle.setPitchOffset(mode === 'deep' ? -0.6 : 0.6); // deep = lower, chipmunk = higher
      src.connect(jungle.input); jungle.output.connect(dst);
      state.jungle = jungle;
    }

    state.audioCtx = ctx;
    const processed = dst.stream.getAudioTracks()[0];
    processed.enabled = state.micOn;
    await replaceOutgoing('audio', processed);
    updateControlUI();
  } catch (e) {
    toast('Ses efekti başlatılamadı.');
    state.voiceMode = 'none';
  }
}

/* -------------------------------- chat --------------------------------- */
function sendChat(text) {
  text = text.trim();
  if (!text) return;
  broadcast({ t: 'chat', text });
  addChatMsg(state.myName, text, true);
}
function addChatMsg(who, text, me) {
  const log = $('chatLog');
  const el = document.createElement('div');
  el.className = 'msg ' + (me ? 'me' : '');
  el.innerHTML = `<div class="who">${escapeHtml(who)}</div><div class="bubble">${escapeHtml(text)}</div>`;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  if (!me && $('chatPanel').classList.contains('hidden')) {
    $('chatBtn').classList.add('active');
    toast(`${who}: ${text.slice(0, 40)}`);
  }
}
function addSysMsg(text) {
  const log = $('chatLog');
  const el = document.createElement('div');
  el.className = 'msg sys'; el.textContent = text;
  log.appendChild(el); log.scrollTop = log.scrollHeight;
}

/* ------------------------------ devices -------------------------------- */
async function refreshDeviceList() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    fillSelect($('camSelect'), devs.filter((d) => d.kind === 'videoinput'), state.rawVideoTrack);
    fillSelect($('micSelect'), devs.filter((d) => d.kind === 'audioinput'), state.rawAudioTrack);
  } catch {}
}
function fillSelect(sel, devs, activeTrack) {
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || `Cihaz ${i + 1}`;
    sel.appendChild(o);
  });
}
async function switchDevice(kind, deviceId) {
  try {
    const constraints = kind === 'video'
      ? { video: { deviceId: { exact: deviceId } } }
      : { audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true } };
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    if (kind === 'video') {
      state.rawVideoTrack?.stop();
      state.rawVideoTrack = s.getVideoTracks()[0];
      state.rawVideoTrack.enabled = state.camOn;
      if (state.bgMode !== 'none') await startSegmentation();
      await updateVideoOutput();
    } else {
      state.rawAudioTrack?.stop();
      state.rawAudioTrack = s.getAudioTracks()[0];
      state.rawAudioTrack.enabled = state.micOn;
      if (state.voiceMode !== 'none') await setVoice(state.voiceMode);
      else await updateAudioOutput();
    }
    toast('Cihaz değiştirildi.');
  } catch { toast('Cihaz değiştirilemedi.'); }
}

/* ------------------------------ misc UI -------------------------------- */
function setNet(text) { $('netStatus').textContent = text; }
function updateNetCount() { setNet(`bağlı • ${state.pcs.size + 1} kişi`); }
function markSel(menuId, attr, val) {
  $(menuId).querySelectorAll(`[data-${attr}]`).forEach((b) =>
    b.classList.toggle('sel', b.dataset[attr] === val));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function togglePopover(id) {
  ['bgMenu', 'voiceMenu', 'settingsMenu'].forEach((m) =>
    $(m).classList.toggle('hidden', m !== id || !$(m).classList.contains('hidden')));
}

/* ------------------------------- join flow ----------------------------- */
async function enterMeeting(room) {
  state.room = room;
  state.myName = ($('nameInput').value || 'Misafir').trim();
  $('lobby').classList.remove('active');
  $('meeting').classList.add('active');
  $('roomCode').textContent = room;
  setNet('kamera hazırlanıyor…');

  await initMedia();
  try {
    await connectWS();
    wsSend({ type: 'join', room, name: state.myName });
    setNet('bağlanıyor…');
  } catch {
    setNet('sunucuya bağlanılamadı');
    toast('Sunucuya bağlanılamadı.');
  }
}

function leaveMeeting() {
  wsSend({ type: 'leave' });
  for (const id of [...state.pcs.keys()]) teardownPeer(id);
  [state.rawVideoTrack, state.rawAudioTrack, state.screenTrack, state.segTrack]
    .forEach((t) => t && t.stop());
  stopSegmentation();
  try { state.audioCtx?.close(); } catch {}
  try { state.ws?.close(); } catch {}
  location.reload();
}

/* ------------------------------- wiring -------------------------------- */
$('createBtn').onclick = () => {
  const pw = makePassword();
  $('createdPw').textContent = pw;
  $('joinInput').value = pw;
  $('createdBox').classList.remove('hidden');
};
$('copyPw').onclick = () => { navigator.clipboard.writeText($('createdPw').textContent); toast('Şifre kopyalandı.'); };
$('enterCreated').onclick = () => enterMeeting($('createdPw').textContent);
$('joinBtn').onclick = () => {
  const code = $('joinInput').value.trim().toUpperCase();
  if (!code) return toast('Şifre gir.');
  enterMeeting(code);
};
$('joinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('joinBtn').click(); });

$('copyRoom').onclick = () => { navigator.clipboard.writeText(state.room); toast('Şifre kopyalandı.'); };
$('micBtn').onclick = toggleMic;
$('camBtn').onclick = toggleCam;
$('screenBtn').onclick = toggleScreen;
$('leaveBtn').onclick = leaveMeeting;

$('bgBtn').onclick = () => togglePopover('bgMenu');
$('voiceBtn').onclick = () => togglePopover('voiceMenu');
$('settingsBtn').onclick = () => togglePopover('settingsMenu');
$('chatBtn').onclick = () => {
  $('chatPanel').classList.toggle('hidden');
  $('chatBtn').classList.remove('active');
};
$('closeChat').onclick = () => $('chatPanel').classList.add('hidden');

$('bgMenu').querySelectorAll('.bg-opt').forEach((b) => b.onclick = () => setBackground(b.dataset.bg));
$('voiceMenu').querySelectorAll('.v-opt').forEach((b) => b.onclick = () => setVoice(b.dataset.v));
$('camSelect').onchange = (e) => switchDevice('video', e.target.value);
$('micSelect').onchange = (e) => switchDevice('audio', e.target.value);

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat($('chatInput').value);
  $('chatInput').value = '';
});

// Close popovers when clicking elsewhere.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.ctrl')) {
    ['bgMenu', 'voiceMenu', 'settingsMenu'].forEach((m) => $(m).classList.add('hidden'));
  }
});
window.addEventListener('beforeunload', () => { try { state.ws?.close(); } catch {} });
