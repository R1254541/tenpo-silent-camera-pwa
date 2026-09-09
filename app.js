const DB_NAME = 'tenpo-silent-camera';
const DB_VERSION = 2;
const STORE = 'captures';
const CONFIG_KEY = 'tenpo-camera-config-v1';
const SESSION_KEY = 'tenpo-camera-session-v1';
const APP_VERSION = '0.4.0';

const el = {
  video: document.querySelector('#preview'),
  canvas: document.querySelector('#captureCanvas'),
  shutter: document.querySelector('#shutter'),
  status: document.querySelector('#statusChip'),
  queue: document.querySelector('#queueChip'),
  local: document.querySelector('#localChip'),
  drive: document.querySelector('#driveChip'),
  galleryOpen: document.querySelector('#galleryBtn'),
  gallery: document.querySelector('#localGallery'),
  galleryClose: document.querySelector('#galleryClose'),
  galleryList: document.querySelector('#galleryList'),
  gallerySummary: document.querySelector('#gallerySummary'),
  galleryRetry: document.querySelector('#galleryRetry'),
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
const sessionState = loadSessionState();
let sessionId = sessionState.sessionId;
let sequence = sessionState.sequence;
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

function idbGet(captureId) {
  return new Promise((resolve, reject) => {
    const req = tx().get(captureId);
    req.onsuccess = () => resolve(req.result);
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


function loadSessionState() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    if (saved.sessionId) return { sessionId: saved.sessionId, sequence: Number(saved.sequence || 0) };
  } catch {}
  const next = { sessionId: crypto.randomUUID(), sequence: 0 };
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

function saveSessionState() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, sequence }));
}

async function getOpfsCaptureDir() {
  if (!navigator.storage?.getDirectory) throw new Error('OPFS_UNAVAILABLE');
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('captures', { create: true });
}

async function writeOpfsVerified(filename, blob, expectedSha) {
  const dir = await getOpfsCaptureDir();
  const handle = await dir.getFileHandle(filename, { create: true });
  const writer = await handle.createWritable();
  await writer.write(blob);
  await writer.close();
  const saved = await handle.getFile();
  if (saved.size !== blob.size) throw new Error('OPFS_SIZE_MISMATCH');
  const actualSha = await sha256Hex(saved);
  if (actualSha !== expectedSha) throw new Error('OPFS_HASH_MISMATCH');
  return { opfsPath: `captures/${filename}`, sizeBytes: saved.size, sha256: actualSha };
}

async function readOpfsBlob(record) {
  if (!record.opfsPath) {
    if (record.blob) return record.blob;
    throw new Error('LOCAL_FILE_MISSING');
  }
  const parts = record.opfsPath.split('/').filter(Boolean);
  const root = await navigator.storage.getDirectory();
  let dir = root;
  for (let i = 0; i < parts.length - 1; i += 1) dir = await dir.getDirectoryHandle(parts[i]);
  const handle = await dir.getFileHandle(parts.at(-1));
  const file = await handle.getFile();
  if (file.size !== record.sizeBytes) throw new Error('LOCAL_SIZE_MISMATCH');
  const actualSha = await sha256Hex(file);
  if (actualSha !== record.sha256) throw new Error('LOCAL_HASH_MISMATCH');
  return file;
}

async function migrateLegacyBlobs() {
  if (!navigator.storage?.getDirectory) return;
  const records = await idbGetAll();
  for (const record of records) {
    if (record.opfsPath || !record.blob) continue;
    const sha = record.sha256 || await sha256Hex(record.blob);
    const verified = await writeOpfsVerified(record.filename, record.blob, sha);
    record.opfsPath = verified.opfsPath;
    record.sha256 = verified.sha256;
    record.sizeBytes = verified.sizeBytes;
    record.localState = 'LOCAL_VERIFIED';
    record.state = record.state === 'VERIFIED' ? 'DRIVE_VERIFIED' : 'QUEUED';
    delete record.blob;
    await idbPut(record);
  }
}

function statusLabel(record) {
  if (record.state === 'DRIVE_VERIFIED') return 'Drive保存済み';
  if (record.state === 'UPLOADING') return 'Drive送信中';
  if (record.state === 'RETRY_WAIT') return '同期待ち';
  return '端末保存済み';
}

function formatCapturedAt(value) {
  try { return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)); }
  catch { return value || ''; }
}

async function shareLocalPhoto(record) {
  const blob = await readOpfsBlob(record);
  const file = new File([blob], record.filename, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] }) && navigator.share) {
    await navigator.share({ files: [file], title: '店舗仕入れ写真' });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = record.filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
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
    saveSessionState();
    el.canvas.width = el.video.videoWidth;
    el.canvas.height = el.video.videoHeight;
    const ctx = el.canvas.getContext('2d', { alpha: false });
    ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);
    const blob = await canvasBlob(el.canvas, 0.95);
    const sha256 = await sha256Hex(blob);
    const settings = track?.getSettings?.() || {};
    const filename = `TC_${isoForFilename(capturedAt)}_${String(sequence).padStart(4, '0')}_${captureId}.jpg`;
    setStatus('端末保存中');
    const local = await writeOpfsVerified(filename, blob, sha256);
    const record = {
      schemaVersion: 3, captureId, sessionId, sequence,
      capturedAt: capturedAt.toISOString(), filename,
      opfsPath: local.opfsPath, mimeType: 'image/jpeg',
      sizeBytes: local.sizeBytes, sha256: local.sha256,
      width: el.canvas.width, height: el.canvas.height,
      zoom: settings.zoom ?? 1, captureEngine: 'pwa-video-frame-canvas',
      localState: 'LOCAL_VERIFIED', state: 'QUEUED', retryCount: 0, nextAttemptAt: 0,
    };
    await idbPut(record);
    const verifiedBlob = await readOpfsBlob(record);
    if (verifiedBlob.size !== record.sizeBytes) throw new Error('LOCAL_READBACK_FAILED');
    setStatus('端末保存済み');
    await refreshQueue();
    void drainQueue();
  } catch (error) {
    console.error(error);
    showWarning(`保存失敗: ${error?.message || 'unknown'}`);
    setStatus('保存エラー');
  } finally { el.shutter.disabled = false; }
}


function retryDelay(retryCount) {
  return [0, 2000, 5000, 15000, 30000, 60000][Math.min(retryCount, 5)];
}

async function drainQueue() {
  if (uploading) return;
  if (!config.endpoint) { setStatus('端末保存のみ'); await refreshQueue(); return; }
  uploading = true;
  try {
    const records = (await idbGetAll())
      .filter(r => (r.localState === 'LOCAL_VERIFIED' || r.opfsPath) && r.state !== 'DRIVE_VERIFIED' && (r.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    for (const record of records) {
      if (!navigator.onLine) break;
      try {
        record.state = 'UPLOADING';
        await idbPut(record);
        const ack = await uploadRecord(record);
        record.state = 'DRIVE_VERIFIED';
        record.driveFileId = ack.drive_file_id;
        record.serverId = ack.server_id || null;
        record.driveVerifiedAt = new Date().toISOString();
        record.retryCount = 0;
        record.nextAttemptAt = 0;
        await idbPut(record);
      } catch (error) {
        console.error('upload failed', error);
        record.retryCount = (record.retryCount || 0) + 1;
        record.state = 'RETRY_WAIT';
        record.nextAttemptAt = Date.now() + retryDelay(record.retryCount);
        await idbPut(record);
        setTimeout(() => void drainQueue(), retryDelay(record.retryCount));
        break;
      }
      await refreshQueue();
    }
  } finally { uploading = false; await refreshQueue(); }
}


async function uploadRecord(record) {
  const image = await readOpfsBlob(record);
  const meta = {
    schema_version: '3.0-pwa', capture_id: record.captureId,
    session_id: record.sessionId, sequence: record.sequence,
    captured_at: record.capturedAt, device_id: config.deviceId || 'iphone17-main',
    app_version: APP_VERSION, mime_type: record.mimeType,
    size_bytes: record.sizeBytes, sha256: record.sha256,
    width: record.width, height: record.height, zoom: record.zoom,
    capture_engine: record.captureEngine,
  };
  const form = new FormData();
  form.append('image', image, record.filename);
  form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'meta.json');
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: config.token ? { 'X-Tenpo-Token': config.token } : {},
    body: form,
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = await response.json().catch(() => ({}));
  if (body.ok === false) throw new Error(body.error || 'SERVER_REJECTED');
  if (body.verified !== true) throw new Error('SERVER_NOT_VERIFIED');
  if (!body.drive_file_id) throw new Error('DRIVE_FILE_ID_MISSING');
  if (body.received_sha256 !== record.sha256) throw new Error('SERVER_HASH_MISMATCH');
  return body;
}


async function refreshQueue() {
  const records = await idbGetAll();
  const localVerified = records.filter(r => r.localState === 'LOCAL_VERIFIED' || r.state === 'DRIVE_VERIFIED').length;
  const driveVerified = records.filter(r => r.state === 'DRIVE_VERIFIED').length;
  const pending = records.filter(r => (r.localState === 'LOCAL_VERIFIED' || r.opfsPath) && r.state !== 'DRIVE_VERIFIED').length;
  el.local.textContent = `端末 ${localVerified}`;
  if (el.drive) el.drive.textContent = `Drive ${driveVerified}`;
  el.queue.textContent = `未送信 ${pending}`;
  el.shotCount.textContent = `撮影 ${records.filter(r => r.sessionId === sessionId).length}`;
  if (!pending && config.endpoint) setStatus('同期済み');
}


async function renderGallery() {
  const records = (await idbGetAll()).sort((a,b) => b.capturedAt.localeCompare(a.capturedAt));
  const driveCount = records.filter(r => r.state === 'DRIVE_VERIFIED').length;
  el.gallerySummary.textContent = `端末 ${records.length}枚 / Drive ${driveCount}枚 / 未送信 ${records.length-driveCount}枚`;
  el.galleryList.replaceChildren();
  for (const record of records) {
    const card = document.createElement('article'); card.className = 'gallery-card';
    const img = document.createElement('img'); img.alt = formatCapturedAt(record.capturedAt);
    try { const blob = await readOpfsBlob(record); img.src = URL.createObjectURL(blob); img.onload=()=>setTimeout(()=>URL.revokeObjectURL(img.src),30000); }
    catch { card.classList.add('gallery-error'); }
    const meta = document.createElement('div'); meta.className='gallery-meta';
    const time = document.createElement('div'); time.textContent = formatCapturedAt(record.capturedAt);
    const state = document.createElement('div'); state.className='gallery-state'; state.textContent = statusLabel(record);
    const actions = document.createElement('div'); actions.className='gallery-actions';
    const share = document.createElement('button'); share.type='button'; share.textContent='共有・保存';
    share.addEventListener('click', async()=>{ try{ await shareLocalPhoto(record); }catch(e){ if(e?.name!=='AbortError') showWarning('共有できませんでした'); }});
    actions.append(share);
    if (record.state !== 'DRIVE_VERIFIED') {
      const retry=document.createElement('button'); retry.type='button'; retry.textContent='再送';
      retry.addEventListener('click', async()=>{ record.state='QUEUED'; record.nextAttemptAt=0; await idbPut(record); await refreshQueue(); void drainQueue(); await renderGallery(); });
      actions.append(retry);
    }
    meta.append(time,state,actions); card.append(img,meta); el.galleryList.append(card);
  }
  if (!records.length) el.galleryList.textContent='端末内に写真はありません';
}

async function openGallery() {
  el.gallery.hidden=false; el.gallery.setAttribute('aria-hidden','false');
  await renderGallery();
}
function closeGallery(){ el.gallery.hidden=true; el.gallery.setAttribute('aria-hidden','true'); }

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
el.galleryOpen.addEventListener('click', () => { void openGallery(); });
el.galleryClose.addEventListener('click', closeGallery);
el.galleryRetry.addEventListener('click', async () => { const records=await idbGetAll(); for (const r of records) { if (r.state !== 'DRIVE_VERIFIED') { r.state='QUEUED'; r.nextAttemptAt=0; await idbPut(r); } } await refreshQueue(); await renderGallery(); void drainQueue(); });
el.zoom.addEventListener('input', e => { void applyZoom(e.target.value); });
document.querySelectorAll('.zoom-btn').forEach(btn => btn.addEventListener('click', () => {
  el.zoom.value = btn.dataset.zoom;
  void applyZoom(btn.dataset.zoom);
}));
el.flash.addEventListener('click', () => { void toggleTorch(); });
el.video.addEventListener('pointerdown', showFocusRing);
window.addEventListener('online', () => { setStatus('再接続'); void drainQueue(); });
window.addEventListener('pageshow', () => { void refreshQueue(); void drainQueue(); });
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
    await migrateLegacyBlobs();
    if (navigator.storage?.persist) { try { await navigator.storage.persist(); } catch {} }
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
