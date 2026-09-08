const DB_NAME = 'tenpo-silent-camera';
const DB_VERSION = 1;
const STORE = 'captures';
const CONFIG_KEY = 'tenpo-camera-config-v1';

const el = {
  video: document.querySelector('#preview'),
  canvas: document.querySelector('#captureCanvas'),
  shutter: document.querySelector('#shutter'),
  status: document.querySelector('#statusChip'),
  queue: document.querySelector('#queueChip'),
  shotCount: document.querySelector('#shotCount'),
  sync: document.querySelector('#syncBtn'),
  zoom: document.querySelector('#zoomSlider'),
  warning: document.querySelector('#warning'),
  focusRing: document.querySelector('#focusRing'),
  flash: document.querySelector('#flashBtn'),
};

let db;
let stream;
let track;
let sessionId = crypto.randomUUID();
let sequence = 0;
let shotCount = 0;
let uploading = false;
let config = loadConfig();

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
  catch { return {}; }
}

function saveConfig(next) {
  config = { ...config, ...next };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function consumeActivationFragment() {
  if (!location.hash.startsWith('#')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const endpoint = p.get('endpoint');
  const token = p.get('token');
  if (endpoint || token) {
    saveConfig({
      ...(endpoint ? { endpoint } : {}),
      ...(token ? { token } : {}),
    });
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'captureId' });
        store.createIndex('state', 'state', { unique: false });
        store.createIndex('capturedAt', 'capturedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode = 'readonly') {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function idbPut(record) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll() {
  return new Promise((resolve, reject) => {
    const req = tx().getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(captureId) {
  return new Promise((resolve, reject) => {
    const req = tx('readwrite').delete(captureId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function isoForFilename(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function startCamera() {
  setStatus('カメラ許可待ち');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    },
  });
  el.video.srcObject = stream;
  await el.video.play();
  track = stream.getVideoTracks()[0];
  configureCapabilities();
  el.shutter.disabled = false;
  setStatus('撮影可能');
}

function configureCapabilities() {
  const caps = track?.getCapabilities?.() || {};
  if (caps.zoom) {
    el.zoom.min = String(caps.zoom.min ?? 1);
    el.zoom.max = String(caps.zoom.max ?? 4);
    el.zoom.step = String(caps.zoom.step ?? 0.1);
    el.zoom.value = String(track.getSettings?.().zoom ?? caps.zoom.min ?? 1);
    el.zoom.disabled = false;
  } else {
    el.zoom.disabled = true;
  }

  if (caps.torch) {
    el.flash.disabled = false;
    el.flash.textContent = 'LIGHT OFF';
  } else {
    el.flash.disabled = true;
    el.flash.textContent = 'LIGHT —';
  }
}

async function applyZoom(value) {
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  if (!caps.zoom) return;
  const z = Math.min(Math.max(Number(value), caps.zoom.min), caps.zoom.max);
  try { await track.applyConstraints({ advanced: [{ zoom: z }] }); }
  catch { showWarning('この端末ではズーム変更を適用できません'); }
}

async function toggleTorch() {
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  if (!caps.torch) return;
  const on = el.flash.dataset.on !== 'true';
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    el.flash.dataset.on = String(on);
    el.flash.textContent = on ? 'LIGHT ON' : 'LIGHT OFF';
  } catch {
    showWarning('ライト制御はこの端末では利用できません');
  }
}

function showFocusRing(event) {
  const r = el.video.getBoundingClientRect();
  el.focusRing.style.left = `${event.clientX - r.left}px`;
  el.focusRing.style.top = `${event.clientY - r.top}px`;
  el.focusRing.hidden = false;
  setTimeout(() => { el.focusRing.hidden = true; }, 500);
}

function canvasBlob(canvas, quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('JPEG_ENCODE_FAILED')), 'image/jpeg', quality);
  });
}

async function capture() {
  if (el.shutter.disabled || !el.video.videoWidth || !el.video.videoHeight) return;
  el.shutter.disabled = true;
  try {
    const capturedAt = new Date();
    const captureId = crypto.randomUUID();
    sequence += 1;

    el.canvas.width = el.video.videoWidth;
    el.canvas.height = el.video.videoHeight;
    const ctx = el.canvas.getContext('2d', { alpha: false });
    ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);
    const blob = await canvasBlob(el.canvas, 0.95);
    const sha256 = await sha256Hex(blob);
    const settings = track?.getSettings?.() || {};

    const record = {
      captureId,
      sessionId,
      sequence,
      capturedAt: capturedAt.toISOString(),
      filename: `TC_${isoForFilename(capturedAt)}_${String(sequence).padStart(4, '0')}_${captureId}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: blob.size,
      sha256,
      width: el.canvas.width,
      height: el.canvas.height,
      zoom: settings.zoom ?? 1,
      captureEngine: 'pwa-video-frame-canvas',
      state: 'QUEUED',
      retryCount: 0,
      nextAttemptAt: 0,
      blob,
    };

    await idbPut(record);
    shotCount += 1;
    el.shotCount.textContent = `撮影 ${shotCount}`;
    setStatus('端末保存済み');
    await refreshQueue();
    void drainQueue();
  } catch (error) {
    console.error(error);
    showWarning(`保存失敗: ${error?.message || 'unknown'}`);
    setStatus('保存エラー');
  } finally {
    el.shutter.disabled = false;
  }
}

function retryDelay(retryCount) {
  return [0, 2000, 5000, 15000, 30000, 60000][Math.min(retryCount, 5)];
}

async function drainQueue() {
  if (uploading) return;
  if (!config.endpoint) {
    setStatus('端末保存のみ');
    return;
  }
  uploading = true;
  try {
    const records = (await idbGetAll())
      .filter(r => r.state !== 'VERIFIED' && (r.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

    for (const record of records) {
      if (!navigator.onLine) break;
      try {
        record.state = 'UPLOADING';
        await idbPut(record);
        await uploadRecord(record);
        record.state = 'VERIFIED';
        await idbPut(record);
        // PWA v0.1 safety policy: keep verified JPEGs locally. Cleanup is a later explicit policy.
      } catch (error) {
        console.error('upload failed', error);
        record.retryCount = (record.retryCount || 0) + 1;
        record.state = 'RETRY_WAIT';
        record.nextAttemptAt = Date.now() + retryDelay(record.retryCount);
        await idbPut(record);
        break;
      }
      await refreshQueue();
    }
  } finally {
    uploading = false;
    await refreshQueue();
  }
}

async function uploadRecord(record) {
  const meta = {
    schema_version: '2.1-pwa',
    capture_id: record.captureId,
    session_id: record.sessionId,
    sequence: record.sequence,
    captured_at: record.capturedAt,
    device_id: config.deviceId || 'iphone17-main',
    app_version: '0.1.0',
    mime_type: record.mimeType,
    size_bytes: record.sizeBytes,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    zoom: record.zoom,
    capture_engine: record.captureEngine,
  };
  const form = new FormData();
  form.append('image', record.blob, record.filename);
  form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'meta.json');

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: config.token ? { 'X-Tenpo-Token': config.token } : {},
    body: form,
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = await response.json().catch(() => ({}));
  if (body.ok === false) throw new Error(body.error || 'SERVER_REJECTED');
}

async function refreshQueue() {
  const records = await idbGetAll();
  const pending = records.filter(r => r.state !== 'VERIFIED').length;
  el.queue.textContent = `未送信 ${pending}`;
  if (!pending && config.endpoint) setStatus('同期済み');
}

function setStatus(text) { el.status.textContent = text; }
function showWarning(text) {
  el.warning.textContent = text;
  el.warning.hidden = false;
  clearTimeout(showWarning.timer);
  showWarning.timer = setTimeout(() => { el.warning.hidden = true; }, 3500);
}

async function recoverInterruptedUploads() {
  const records = await idbGetAll();
  for (const record of records) {
    if (record.state === 'UPLOADING') {
      record.state = 'QUEUED';
      record.nextAttemptAt = 0;
      await idbPut(record);
    }
  }
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); }
    catch (error) { console.warn('service worker registration failed', error); }
  }
}

el.shutter.addEventListener('click', capture);
el.sync.addEventListener('click', () => { void drainQueue(); });
el.zoom.addEventListener('input', e => { void applyZoom(e.target.value); });
document.querySelectorAll('.zoom-btn').forEach(btn => btn.addEventListener('click', () => {
  el.zoom.value = btn.dataset.zoom;
  void applyZoom(btn.dataset.zoom);
}));
el.flash.addEventListener('click', () => { void toggleTorch(); });
el.video.addEventListener('pointerdown', showFocusRing);
window.addEventListener('online', () => { setStatus('再接続'); void drainQueue(); });
window.addEventListener('pagehide', () => stream?.getTracks().forEach(t => t.stop()));

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && (!stream || stream.getVideoTracks().every(t => t.readyState === 'ended'))) {
    try { await startCamera(); } catch (error) { console.warn(error); }
    void drainQueue();
  }
});

(async function init() {
  try {
    if (!window.isSecureContext) throw new Error('HTTPS_REQUIRED');
    consumeActivationFragment();
    db = await openDb();
    await recoverInterruptedUploads();
    await registerServiceWorker();
    await refreshQueue();
    await startCamera();
    void drainQueue();
  } catch (error) {
    console.error(error);
    setStatus('起動失敗');
    showWarning(error?.name === 'NotAllowedError' ? 'カメラ許可が必要です' : `起動エラー: ${error?.message || 'unknown'}`);
  }
})();
