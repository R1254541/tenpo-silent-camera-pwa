import base64
import hashlib
import io
import json
import os
import re
from datetime import datetime, timezone

import google.auth
from flask import Flask, jsonify, request
from google.cloud import storage
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

app = Flask(__name__)
BUCKET = os.environ.get('BUCKET', 'm-bridge-504512-tenpo-camera-ingress')
STAGING_PARENT_ID = os.environ.get('DRIVE_STAGING_FOLDER_ID', '1JE9ZpfCfY5gJHD0Z89H1Z3xsGwLqf-g_')
RELEASE_PARENT_ID = os.environ.get('DRIVE_RELEASE_FOLDER_ID', '1jYxWoa5mkfyRHQpDoGTNW8_3mgHcFS41')
TOKEN = os.environ.get('TENPO_TOKEN', '').strip()
if not TOKEN:
    token_path = os.path.join(os.path.dirname(__file__), 'token.txt')
    if os.path.exists(token_path):
        TOKEN = open(token_path, encoding='utf-8').read().strip()

client = storage.Client()
bucket = client.bucket(BUCKET)
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$')
DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
_drive = None


def drive():
    global _drive
    if _drive is None:
        creds, _ = google.auth.default(scopes=[DRIVE_SCOPE])
        _drive = build('drive', 'v3', credentials=creds, cache_discovery=False)
    return _drive


def auth_ok():
    return bool(TOKEN) and request.headers.get('X-Tenpo-Token', '') == TOKEN


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = 'https://r1254541.github.io'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type,X-Tenpo-Token'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return resp


@app.after_request
def after(resp):
    return cors(resp)


def qescape(value):
    return str(value).replace('\\', '\\\\').replace("'", "\\'")


def find_folder(name, parent_id):
    q = f"name = '{qescape(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '{parent_id}' in parents"
    rows = drive().files().list(q=q, spaces='drive', fields='files(id,name,parents)', pageSize=10).execute().get('files', [])
    return rows[0] if rows else None


def ensure_folder(name, parent_id):
    found = find_folder(name, parent_id)
    if found:
        return found['id']
    body = {'name': name, 'mimeType': 'application/vnd.google-apps.folder', 'parents': [parent_id]}
    return drive().files().create(body=body, fields='id').execute()['id']


def find_file(name, parent_id):
    q = f"name = '{qescape(name)}' and trashed = false and '{parent_id}' in parents"
    rows = drive().files().list(q=q, spaces='drive', fields='files(id,name,parents,appProperties,size)', pageSize=10).execute().get('files', [])
    return rows[0] if rows else None


def upload_bytes(name, parent_id, data, mime_type, app_properties=None):
    found = find_file(name, parent_id)
    if found:
        return found['id']
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime_type, resumable=False)
    body = {'name': name, 'parents': [parent_id]}
    if app_properties:
        body['appProperties'] = {k: str(v) for k, v in app_properties.items()}
    return drive().files().create(body=body, media_body=media, fields='id').execute()['id']


def replace_bytes(name, parent_id, data, mime_type):
    found = find_file(name, parent_id)
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype=mime_type, resumable=False)
    if found:
        drive().files().update(fileId=found['id'], media_body=media, fields='id').execute()
        return found['id']
    return drive().files().create(body={'name': name, 'parents': [parent_id]}, media_body=media, fields='id').execute()['id']


def download_bytes(file_id):
    req = drive().files().get_media(fileId=file_id)
    fh = io.BytesIO()
    dl = MediaIoBaseDownload(fh, req)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return fh.getvalue()


def verify_drive_file(file_id, expected_sha, expected_size):
    data = download_bytes(file_id)
    if len(data) != int(expected_size):
        raise ValueError('DRIVE_SIZE_MISMATCH')
    if sha256(data) != expected_sha:
        raise ValueError('DRIVE_HASH_MISMATCH')
    return True


def session_folder(sid, create=False):
    found = find_folder(sid, STAGING_PARENT_ID)
    if found:
        return found['id'], 'staging'
    found = find_folder(sid, RELEASE_PARENT_ID)
    if found:
        return found['id'], 'released'
    if create:
        return ensure_folder(sid, STAGING_PARENT_ID), 'staging'
    return None, None


def move_session_to_release(folder_id):
    meta = drive().files().get(fileId=folder_id, fields='parents').execute()
    parents = meta.get('parents', [])
    if RELEASE_PARENT_ID in parents:
        return
    drive().files().update(
        fileId=folder_id,
        addParents=RELEASE_PARENT_ID,
        removeParents=','.join(parents),
        fields='id,parents',
    ).execute()


@app.route('/health', methods=['GET'])
def health():
    drive_access = False
    drive_error = None
    try:
        drive().files().get(fileId=STAGING_PARENT_ID, fields='id,name').execute()
        drive_access = True
    except Exception as e:
        drive_error = type(e).__name__
    return jsonify(ok=True, service='tenpo-camera-ingress-cloudrun-v2', drive_enabled=True, drive_access=drive_access, drive_error=drive_error)


@app.route('/provision', methods=['POST', 'OPTIONS'])
def provision():
    if request.method == 'OPTIONS':
        return ('', 204)
    body = request.get_json(force=True, silent=True) or {}
    code = str(body.get('code', '')).strip()
    if not code or len(code) > 128:
        return jsonify(ok=False, error='INVALID_PROVISION_CODE'), 400
    marker = bucket.blob('provision/current.json')
    if not marker.exists():
        return jsonify(ok=False, error='PROVISION_NOT_AVAILABLE'), 404
    try:
        cfg = json.loads(marker.download_as_text())
    except Exception:
        return jsonify(ok=False, error='PROVISION_CONFIG_INVALID'), 500
    if cfg.get('used_at'):
        return jsonify(ok=False, error='PROVISION_ALREADY_USED'), 409
    expected = str(cfg.get('code_sha256', ''))
    if not expected or sha256(code.encode('utf-8')) != expected:
        return jsonify(ok=False, error='PROVISION_UNAUTHORIZED'), 401
    if not TOKEN:
        return jsonify(ok=False, error='TOKEN_NOT_CONFIGURED'), 500
    cfg['used_at'] = datetime.now(timezone.utc).isoformat()
    marker.upload_from_string(json.dumps(cfg, ensure_ascii=False), content_type='application/json')
    return jsonify(ok=True, endpoint=request.url_root.rstrip('/'), transport='cloud-run', token=TOKEN)


@app.route('/capture', methods=['POST', 'OPTIONS'])
def capture():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not auth_ok():
        return jsonify(ok=False, error='UNAUTHORIZED'), 401
    if request.is_json:
        body = request.get_json(force=True, silent=True) or {}
        meta = body.get('meta') or {}
        image_b64 = body.get('image_b64') or ''
        try:
            data = base64.b64decode(image_b64, validate=True)
        except Exception:
            return jsonify(ok=False, error='INVALID_BASE64'), 400
    else:
        if 'image' not in request.files or 'meta' not in request.files:
            return jsonify(ok=False, error='INVALID_MULTIPART'), 400
        meta = json.load(request.files['meta'])
        data = request.files['image'].read()

    for k in ('capture_id', 'session_id', 'sequence', 'sha256', 'mime_type', 'size_bytes'):
        if k not in meta:
            return jsonify(ok=False, error='INVALID_META'), 400
    if not UUID_RE.match(str(meta['capture_id'])) or not UUID_RE.match(str(meta['session_id'])):
        return jsonify(ok=False, error='INVALID_ID'), 400
    if not data or len(data) > 12 * 1024 * 1024:
        return jsonify(ok=False, error='INVALID_SIZE'), 400
    got = sha256(data)
    if got != meta['sha256']:
        return jsonify(ok=False, error='CLIENT_HASH_MISMATCH'), 400

    seq = int(meta['sequence'])
    gcs_name = f"sessions/{meta['session_id']}/TC_{seq:04d}_{meta['capture_id']}.jpg"
    blob = bucket.blob(gcs_name)
    if not blob.exists():
        blob.upload_from_string(data, content_type='image/jpeg')
    rb = blob.download_as_bytes()
    if len(rb) != len(data) or sha256(rb) != got:
        return jsonify(ok=False, error='GCS_READBACK_HASH_MISMATCH'), 500

    mb = bucket.blob(f"sessions/{meta['session_id']}/META_{seq:04d}_{meta['capture_id']}.json")
    mb.upload_from_string(json.dumps(meta, ensure_ascii=False), content_type='application/json')

    try:
        sfid, where = session_folder(str(meta['session_id']), create=True)
        if where == 'released':
            return jsonify(ok=False, error='SESSION_ALREADY_RELEASED'), 409
        drive_name = f"TC_{seq:04d}_{meta['capture_id']}.jpg"
        dfid = upload_bytes(
            drive_name,
            sfid,
            data,
            'image/jpeg',
            {'capture_id': meta['capture_id'], 'session_id': meta['session_id'], 'sequence': seq, 'sha256': got},
        )
        verify_drive_file(dfid, got, len(data))
        meta_bytes = json.dumps(meta, ensure_ascii=False, indent=2).encode('utf-8')
        replace_bytes(f"META_{seq:04d}_{meta['capture_id']}.json", sfid, meta_bytes, 'application/json')
    except Exception as e:
        app.logger.exception('Drive staging failed')
        return jsonify(ok=False, error='DRIVE_STAGE_FAILED', detail=str(e)[:240]), 503

    return jsonify(
        ok=True,
        ingress_verified=True,
        drive_staged_verified=True,
        server_id=gcs_name,
        drive_file_id=dfid,
        received_sha256=got,
    )


@app.route('/commit', methods=['POST', 'OPTIONS'])
def commit():
    if request.method == 'OPTIONS':
        return ('', 204)
    if not auth_ok():
        return jsonify(ok=False, error='UNAUTHORIZED'), 401
    body = request.get_json(force=True, silent=True) or {}
    sid = str(body.get('session_id', ''))
    expected = int(body.get('expected_count') or 0)
    if not UUID_RE.match(sid) or expected < 1:
        return jsonify(ok=False, error='INVALID_COMMIT'), 400

    metas = []
    for b in client.list_blobs(BUCKET, prefix=f'sessions/{sid}/META_'):
        metas.append(json.loads(b.download_as_text()))
    metas.sort(key=lambda m: int(m['sequence']))
    if len(metas) != expected or [int(m['sequence']) for m in metas] != list(range(1, expected + 1)):
        return jsonify(ok=False, error='SESSION_COUNT_MISMATCH'), 409
    if len({m['capture_id'] for m in metas}) != expected:
        return jsonify(ok=False, error='SESSION_DUPLICATE_CAPTURE_ID'), 409

    sfid, where = session_folder(sid, create=False)
    if not sfid:
        return jsonify(ok=False, error='DRIVE_SESSION_MISSING'), 409

    manifest = {'schema_version': 'cloudrun-drive-2', 'session_id': sid, 'expected_count': expected, 'images': []}
    status_images = []
    try:
        for m in metas:
            seq = int(m['sequence'])
            gcs_name = f"sessions/{sid}/TC_{seq:04d}_{m['capture_id']}.jpg"
            data = bucket.blob(gcs_name).download_as_bytes()
            if sha256(data) != m['sha256']:
                return jsonify(ok=False, error='SESSION_HASH_MISMATCH'), 409
            drive_name = f"TC_{seq:04d}_{m['capture_id']}.jpg"
            dfile = find_file(drive_name, sfid)
            if not dfile:
                return jsonify(ok=False, error='DRIVE_FILE_MISSING'), 409
            verify_drive_file(dfile['id'], m['sha256'], len(data))
            image_info = {
                'capture_id': m['capture_id'], 'sequence': seq, 'captured_at': m.get('captured_at'),
                'filename': drive_name, 'size_bytes': len(data), 'sha256': m['sha256'], 'drive_file_id': dfile['id'],
            }
            manifest['images'].append(image_info)
            status_images.append({'capture_id': m['capture_id'], 'sequence': seq, 'sha256': m['sha256'], 'drive_file_id': dfile['id'], 'drive_path': f'_camera_batches/{sid}/{drive_name}'})

        manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8')
        replace_bytes('batch_manifest.json', sfid, manifest_bytes, 'application/json')
        move_session_to_release(sfid)
        ready = {'session_id': sid, 'expected_count': expected, 'verified_at': datetime.now(timezone.utc).isoformat()}
        replace_bytes('_READY.json', sfid, json.dumps(ready, ensure_ascii=False, indent=2).encode('utf-8'), 'application/json')
        verified_at = datetime.now(timezone.utc).isoformat()
        status = {'ok': True, 'drive_verified': True, 'session_id': sid, 'expected_count': expected, 'verified_at': verified_at, 'images': status_images}
        bucket.blob(f'status/{sid}.json').upload_from_string(json.dumps(status, ensure_ascii=False), content_type='application/json')
    except Exception as e:
        app.logger.exception('Drive commit failed')
        return jsonify(ok=False, error='DRIVE_COMMIT_FAILED', detail=str(e)[:240]), 503

    return jsonify(ok=True, released=True, drive_verified=True, session_id=sid, expected_count=expected)


@app.route('/status/<sid>', methods=['GET'])
def status(sid):
    if not auth_ok():
        return jsonify(ok=False, error='UNAUTHORIZED'), 401
    b = bucket.blob(f'status/{sid}.json')
    if not b.exists():
        return jsonify(ok=True, drive_verified=False)
    return jsonify(json.loads(b.download_as_text()))


