import base64, hashlib, json, uuid
from datetime import datetime, timezone
import main

TEST_TOKEN = 'synthetic-e2e-local-only'
main.TOKEN = TEST_TOKEN
client = main.app.test_client()

sid, cid = str(uuid.uuid4()), str(uuid.uuid4())
img = ('TENPO_E2E_' + str(uuid.uuid4())).encode('utf-8')
sha = hashlib.sha256(img).hexdigest()
meta = {
    'schema_version': '3.0-pwa', 'capture_id': cid, 'session_id': sid,
    'sequence': 1, 'captured_at': datetime.now(timezone.utc).isoformat(),
    'device_id': 'cloud-run-e2e-job', 'app_version': '0.6.6',
    'mime_type': 'image/jpeg', 'size_bytes': len(img), 'sha256': sha,
    'width': 1, 'height': 1, 'zoom': 1, 'capture_engine': 'synthetic-e2e',
}
headers = {'X-Tenpo-Token': TEST_TOKEN}

cap = client.post('/capture', json={
    'meta': meta, 'image_b64': base64.b64encode(img).decode('ascii')
}, headers=headers)
assert cap.status_code == 200, cap.get_data(as_text=True)
capj = cap.get_json()
assert capj.get('ok') and capj.get('ingress_verified')
assert capj.get('received_sha256') == sha
print('CAPTURE_PASS')
com = client.post('/commit', json={'session_id': sid, 'expected_count': 1}, headers=headers)
assert com.status_code == 200, com.get_data(as_text=True)
comj = com.get_json()
assert comj.get('ok') and comj.get('drive_verified')
print('COMMIT_PASS')

st = client.get('/status/' + sid, headers=headers)
assert st.status_code == 200, st.get_data(as_text=True)
stj = st.get_json()
assert stj.get('drive_verified') is True
assert len(stj.get('images') or []) == 1 and stj['images'][0].get('sha256') == sha
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
