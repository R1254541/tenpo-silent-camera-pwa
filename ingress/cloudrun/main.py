import base64, hashlib, json, os, re
from flask import Flask, request, jsonify
from google.cloud import storage

app = Flask(__name__)
BUCKET = os.environ.get('BUCKET','m-bridge-504512-tenpo-camera-ingress')
TOKEN = open(os.path.join(os.path.dirname(__file__),'token.txt'),encoding='utf-8').read().strip()
client = storage.Client()
bucket = client.bucket(BUCKET)
UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}$')

def auth_ok():
    return request.headers.get('X-Tenpo-Token','') == TOKEN

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = 'https://r1254541.github.io'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type,X-Tenpo-Token'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'
    return resp

@app.after_request
def after(resp): return cors(resp)

@app.route('/health', methods=['GET'])
def health(): return jsonify(ok=True, service='tenpo-camera-ingress-cloudrun-v1')

@app.route('/capture', methods=['POST','OPTIONS'])
def capture():
    if request.method == 'OPTIONS': return ('',204)
    if not auth_ok(): return jsonify(ok=False,error='UNAUTHORIZED'),401
    if request.is_json:
        body = request.get_json(force=True, silent=True) or {}
        meta = body.get('meta') or {}
        image_b64 = body.get('image_b64') or ''
        try:
            import base64
            data = base64.b64decode(image_b64, validate=True)
        except Exception:
            return jsonify(ok=False,error='INVALID_BASE64'),400
    else:
        if 'image' not in request.files or 'meta' not in request.files:
            return jsonify(ok=False,error='INVALID_MULTIPART'),400
        meta = json.load(request.files['meta'])
        data = request.files['image'].read()
    for k in ('capture_id','session_id','sequence','sha256','mime_type','size_bytes'):
        if k not in meta:
            print('REJECT INVALID_META missing=',k,'meta=',meta, flush=True); return jsonify(ok=False,error='INVALID_META'),400
    if not UUID_RE.match(str(meta['capture_id'])) or not UUID_RE.match(str(meta['session_id'])):
        print('REJECT INVALID_ID',meta.get('capture_id'),meta.get('session_id'), flush=True); return jsonify(ok=False,error='INVALID_ID'),400
    if not data or len(data) > 12*1024*1024: return jsonify(ok=False,error='INVALID_SIZE'),400
    got = sha256(data)
    if got != meta['sha256']: return jsonify(ok=False,error='CLIENT_HASH_MISMATCH'),400
    seq = int(meta['sequence'])
    name = f"sessions/{meta['session_id']}/TC_{seq:04d}_{meta['capture_id']}.jpg"
    blob = bucket.blob(name)
    if not blob.exists(): blob.upload_from_string(data, content_type='image/jpeg')
    rb = blob.download_as_bytes()
    if len(rb)!=len(data) or sha256(rb)!=got: return jsonify(ok=False,error='GCS_READBACK_HASH_MISMATCH'),500
    mb = bucket.blob(f"sessions/{meta['session_id']}/META_{seq:04d}_{meta['capture_id']}.json")
    mb.upload_from_string(json.dumps(meta,ensure_ascii=False),content_type='application/json')
    return jsonify(ok=True, ingress_verified=True, server_id=name, received_sha256=got)

@app.route('/commit', methods=['POST','OPTIONS'])
def commit():
    if request.method == 'OPTIONS': return ('',204)
    if not auth_ok(): return jsonify(ok=False,error='UNAUTHORIZED'),401
    body = request.get_json(force=True,silent=True) or {}
    sid = str(body.get('session_id','')); expected=int(body.get('expected_count') or 0)
    if not UUID_RE.match(sid) or expected < 1: return jsonify(ok=False,error='INVALID_COMMIT'),400
    metas=[]
    for b in client.list_blobs(BUCKET,prefix=f'sessions/{sid}/META_'):
        metas.append(json.loads(b.download_as_text()))
    metas.sort(key=lambda m:int(m['sequence']))
    if len(metas)!=expected or [int(m['sequence']) for m in metas] != list(range(1,expected+1)):
        return jsonify(ok=False,error='SESSION_COUNT_MISMATCH'),409
    manifest={'schema_version':'cloudrun-1','session_id':sid,'expected_count':expected,'images':[]}
    for m in metas:
        seq=int(m['sequence']); name=f"sessions/{sid}/TC_{seq:04d}_{m['capture_id']}.jpg"; b=bucket.blob(name); data=b.download_as_bytes()
        if sha256(data)!=m['sha256']: return jsonify(ok=False,error='SESSION_HASH_MISMATCH'),409
        manifest['images'].append({'capture_id':m['capture_id'],'sequence':seq,'captured_at':m.get('captured_at'),'filename':name.rsplit('/',1)[1],'size_bytes':len(data),'sha256':m['sha256']})
    bucket.blob(f'sessions/{sid}/batch_manifest.json').upload_from_string(json.dumps(manifest,ensure_ascii=False,indent=2),content_type='application/json')
    bucket.blob(f'sessions/{sid}/_READY.json').upload_from_string(json.dumps({'session_id':sid,'expected_count':expected}),content_type='application/json')
    return jsonify(ok=True,released=True,session_id=sid,expected_count=expected)

@app.route('/status/<sid>', methods=['GET'])
def status(sid):
    if request.headers.get('X-Tenpo-Token','') != TOKEN: return jsonify(ok=False,error='UNAUTHORIZED'),401
    b=bucket.blob(f'status/{sid}.json')
    if not b.exists(): return jsonify(ok=True,drive_verified=False)
    return jsonify(json.loads(b.download_as_text()))
