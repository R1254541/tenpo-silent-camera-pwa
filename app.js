const DB_NAME = 'tenpo-silent-camera';
const DB_VERSION = 2;
const STORE = 'captures';
const CONFIG_KEY = 'tenpo-camera-config-v1';
const SESSION_KEY = 'tenpo-camera-session-v1';
const APP_VERSION = '0.6.0';
const COMMIT_IDLE_MS = 60000;

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
let commitTimer = null;
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
  const transport = p.get('transport');
  if (endpoint || token || transport) {
    saveConfig({
      ...(endpoint ? { endpoint } : {}),
      ...(token ? { token } : {}),
      ...(transport ? { transport } : {}),
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
    if (saved.sessionId) return { sessionId: saved.sessionId, sequence: Number(saved.sequence || 0), lastCaptureAt: saved.lastCaptureAt || null, released: Boolean(saved.released) };
  } catch {}
  const next = { sessionId: crypto.randomUUID(), sequence: 0 };
  localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  return next;
}

function saveSessionState(extra = {}) {
  const current = loadSessionState();
  localStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, sequence, lastCaptureAt: current.lastCaptureAt || null, released: current.released || false, ...extra }));
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
  if (record.state === 'UPLOADING') return '送信中';
  if (record.state === 'INGRESS_VERIFIED') return 'Drive反映待ち';
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
    const sess = loadSessionState();
    if (sess.released) { sessionId = crypto.randomUUID(); sequence = 0; saveSessionState({ released: false, lastCaptureAt: null }); }
    sequence += 1;
    saveSessionState({ released: false, lastCaptureAt: capturedAt.toISOString() });
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
    scheduleSessionCommit();
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
      .filter(r => (r.localState === 'LOCAL_VERIFIED' || r.opfsPath) && !['DRIVE_VERIFIED','INGRESS_VERIFIED'].includes(r.state) && (r.nextAttemptAt || 0) <= Date.now())
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    for (const record of records) {
      if (!navigator.onLine) break;
      try {
        record.state = 'UPLOADING';
        await idbPut(record);
        const ack = await uploadRecord(record);
        if ((config.transport || '').toLowerCase() === 'cloud-run') {
          record.state = 'INGRESS_VERIFIED';
          record.serverId = ack.server_id || null;
          record.ingressVerifiedAt = new Date().toISOString();
        } else {
          record.state = 'DRIVE_VERIFIED';
          record.driveFileId = ack.drive_file_id;
          record.serverId = ack.server_id || null;
          record.driveVerifiedAt = new Date().toISOString();
        }
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
  } finally { uploading = false; await refreshQueue(); scheduleSessionCommit(); }
}


function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('BASE64_ENCODE_FAILED'));
    reader.readAsDataURL(blob);
  });
}

function postViaIframe(fields, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    const frameName = `tenpo_ingress_${crypto.randomUUID()}`;
    iframe.name = frameName; iframe.hidden = true;
    const form = document.createElement('form');
    form.method = 'POST'; form.action = config.endpoint; form.target = frameName;
    form.enctype = 'multipart/form-data'; form.hidden = true;
    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement(name === 'image_b64' ? 'textarea' : 'input');
      input.name = name; input.value = String(value ?? ''); form.appendChild(input);
    });
    let timer;
    const cleanup = () => { clearTimeout(timer); window.removeEventListener('message', onMessage); form.remove(); iframe.remove(); };
    const onMessage = event => {
      if (event.source !== iframe.contentWindow || !event.data || typeof event.data !== 'object') return;
      cleanup(); event.data.ok === false ? reject(new Error(event.data.error || 'SERVER_REJECTED')) : resolve(event.data);
    };
    window.addEventListener('message', onMessage); document.body.append(iframe, form);
    timer = setTimeout(() => { cleanup(); reject(new Error('INGRESS_TIMEOUT')); }, timeoutMs);
    form.submit();
  });
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
  let body;
  if ((config.transport || '').toLowerCase() === 'apps-script') {
    body = await postViaIframe({ action: 'capture', token: config.token || '', meta: JSON.stringify(meta), image_b64: await blobToBase64(image) });
  } else {
    const form = new FormData();
    form.append('image', image, record.filename);
    form.append('meta', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'meta.json');
    const target = (config.transport || '').toLowerCase() === 'cloud-run' ? `${config.endpoint}/capture` : config.endpoint;
    const response = await fetch(target, { method: 'POST', headers: config.token ? { 'X-Tenpo-Token': config.token } : {}, body: form });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    body = await response.json().catch(() => ({}));
  }
  if (body.ok === false) throw new Error(body.error || 'SERVER_REJECTED');
  if ((config.transport || '').toLowerCase() === 'cloud-run') {
    if (body.ingress_verified !== true) throw new Error('INGRESS_NOT_VERIFIED');
  } else {
    if (body.verified !== true) throw new Error('SERVER_NOT_VERIFIED');
    if (!body.drive_file_id) throw new Error('DRIVE_FILE_ID_MISSING');
  }
  if (body.received_sha256 !== record.sha256) throw new Error('SERVER_HASH_MISMATCH');
  return body;
}


async function commitCurrentSession() {
  if (!config.endpoint) return false;
  const transport = (config.transport || '').toLowerCase();
  if (!['apps-script','cloud-run'].includes(transport)) return false;
  const sess = loadSessionState();
  if (!sess.sessionId || sess.released || !sess.sequence) return false;
  const records = (await idbGetAll()).filter(r => r.sessionId === sess.sessionId);
  const accepted = transport === 'cloud-run' ? ['INGRESS_VERIFIED','DRIVE_VERIFIED'] : ['DRIVE_VERIFIED'];
  if (records.length !== sess.sequence || records.some(r => !accepted.includes(r.state))) return false;
  let body;
  if (transport === 'apps-script') {
    body = await postViaIframe({ action: 'commit', token: config.token || '', session_id: sess.sessionId, expected_count: sess.sequence });
  } else {
    const response = await fetch(`${config.endpoint}/commit`, { method:'POST', headers:{ 'Content-Type':'application/json', ...(config.token ? { 'X-Tenpo-Token': config.token } : {}) }, body:JSON.stringify({ session_id:sess.sessionId, expected_count:sess.sequence }) });
    if (!response.ok) throw new Error(`COMMIT_HTTP_${response.status}`);
    body = await response.json();
  }
  if (body.released !== true) throw new Error('SESSION_NOT_RELEASED');
  saveSessionState({ released: true, lastCaptureAt: sess.lastCaptureAt || null });
  setStatus(transport === 'cloud-run' ? 'Drive反映待ち' : 'Drive保存済み');
  if (transport === 'cloud-run') void checkDriveStatuses();
  return true;
}

async function checkDriveStatuses() {
  if ((config.transport || '').toLowerCase() !== 'cloud-run' || !config.endpoint) return;
  const records = await idbGetAll();
  const sessionIds = [...new Set(records.filter(r => r.state === 'INGRESS_VERIFIED').map(r => r.sessionId))];
  for (const sid of sessionIds) {
    try {
      const response = await fetch(`${config.endpoint}/status/${encodeURIComponent(sid)}`, { headers: config.token ? { 'X-Tenpo-Token': config.token } : {} });
      if (!response.ok) continue;
      const body = await response.json();
      if (body.drive_verified !== true || !Array.isArray(body.images)) continue;
      const byId = new Map(body.images.map(x => [x.capture_id, x]));
      for (const record of records.filter(r => r.sessionId === sid && r.state === 'INGRESS_VERIFIED')) {
        const remote = byId.get(record.captureId);
        if (!remote || remote.sha256 !== record.sha256) continue;
        record.state = 'DRIVE_VERIFIED';
        record.driveFileId = remote.drive_file_id || remote.drive_path || null;
        record.driveVerifiedAt = body.verified_at || new Date().toISOString();
        await idbPut(record);
      }
    } catch (err) { console.warn('drive status check failed', err); }
  }
  await refreshQueue();
}

function scheduleSessionCommit() {
  clearTimeout(commitTimer);
  const sess = loadSessionState();
  if (!sess.lastCaptureAt || sess.released) return;
  const due = Math.max(0, COMMIT_IDLE_MS - (Date.now() - Date.parse(sess.lastCaptureAt)));
  commitTimer = setTimeout(() => { void commitCurrentSession().catch(err => console.warn('commit failed', err)); }, due);
}

async function recoverSessionCommit() {
  const sess = loadSessionState();
  if (!sess.lastCaptureAt || sess.released) return;
  if (Date.now() - Date.parse(sess.lastCaptureAt) >= COMMIT_IDLE_MS) await commitCurrentSession();
  else scheduleSessionCommit();
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
el.sync.addEventListener('click', () => { void drainQueue(); void checkDriveStatuses(); });
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
window.addEventListener('online', () => { setStatus('再接続'); void drainQueue(); void checkDriveStatuses(); });
window.addEventListener('pageshow', () => { void refreshQueue(); void drainQueue(); void checkDriveStatuses(); });
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
    void recoverSessionCommit().catch(err => console.warn('commit recovery failed', err));
    void checkDriveStatuses();
    setInterval(() => { if (document.visibilityState === 'visible') void checkDriveStatuses(); }, 15000);
  } catch (error) {
    console.error(error);
    setStatus('起動失敗');
    showWarning(error?.name === 'NotAllowedError' ? 'カメラ許可が必要です' : `起動エラー: ${error?.message || 'unknown'}`);
  }
})();
