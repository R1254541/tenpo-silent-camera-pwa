import base64, hashlib, json, os, sys, urllib.request, urllib.error, uuid
from datetime import datetime, timezone
import main

URL = os.environ['SERVICE_URL'].rstrip('/')
TOKEN = os.environ['TENPO_TOKEN']

def post(path, body):
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(URL + path, data=data, method='POST', headers={
        'Content-Type': 'application/json', 'X-Tenpo-Token': TOKEN,
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8') or '{}')

def get(path):
    req = urllib.request.Request(URL + path, headers={'X-Tenpo-Token': TOKEN})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, json.load(r)

sid, cid = str(uuid.uuid4()), str(uuid.uuid4())
img = ('TENPO_E2E_' + str(uuid.uuid4())).encode('utf-8')
sha = hashlib.sha256(img).hexdigest()
meta = {
    'schema_version': '3.0-pwa', 'capture_id': cid, 'session_id': sid,
    'sequence': 1, 'captured_at': datetime.now(timezone.utc).isoformat(),
    'device_id': 'github-e2e-job', 'app_version': '0.6.6',
    'mime_type': 'image/jpeg', 'size_bytes': len(img), 'sha256': sha,
    'width': 1, 'height': 1, 'zoom': 1, 'capture_engine': 'synthetic-e2e',
}
status, cap = post('/capture', {'meta': meta, 'image_b64': base64.b64encode(img).decode('ascii')})
assert status == 200 and cap.get('ok') and cap.get('ingress_verified')
assert cap.get('received_sha256') == sha
print('CAPTURE_PASS')

status, com = post('/commit', {'session_id': sid, 'expected_count': 1})
assert status == 200 and com.get('ok') and com.get('drive_verified')
print('COMMIT_PASS')

status, st = get('/status/' + sid)
assert status == 200 and st.get('drive_verified') is True
assert len(st.get('images') or []) == 1 and st['images'][0].get('sha256') == sha
print('STATUS_PASS')

folder_id, where = main.session_folder(sid, create=False)
assert folder_id and where == 'released'
img_file = main.find_file(f'TC_0001_{cid}.jpg', folder_id)
manifest_file = main.find_file('batch_manifest.json', folder_id)
ready_file = main.find_file('_READY.json', folder_id)
assert img_file and manifest_file and ready_file
main.verify_drive_file(img_file['id'], sha, len(img))
manifest = json.loads(main.download_bytes(manifest_file['id']).decode('utf-8'))
ready = json.loads(main.download_bytes(ready_file['id']).decode('utf-8'))
assert manifest.get('session_id') == sid and manifest.get('expected_count') == 1
assert ready.get('session_id') == sid and ready.get('expected_count') == 1
print('DRIVE_READBACK_PASS')
print('E2E_PASS session_id=' + sid)
