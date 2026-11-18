"""Protected workflow entry points. Never log response bodies or registration credentials."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from candidates import TARGETS, CLI, LOADER, digest, entries

ORIGIN='https://emrank.tech'
ROOT=Path(__file__).resolve().parents[2]
POOL=ROOT/'sealed'
REGISTRY='https://registry.npmjs.org'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None


def request(url,method='GET',data=None,headers=None,missing=False):
    op=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    req=urllib.request.Request(url,method=method,data=None if data is None else json.dumps(data).encode(),headers=headers or {})
    try:
        with op.open(req,timeout=30) as response: return response.read()
    except urllib.error.HTTPError as exc:
        if exc.code==404 and missing: return None
        raise SystemExit(f'{method} {req.host} rejected release step (HTTP {exc.code})') from None


def gateway(path,data):
    app=os.environ['EMRANK_APP_ID']; assert re.fullmatch(r'[1-9][0-9]*',app) and os.environ['EMRANK_ISSUER']==ORIGIN
    return json.loads(request(f'{ORIGIN}/oauth/releases/{app}/{path}','POST',data,{'Authorization':'Bearer '+os.environ['EMRANK_RELEASE_CREDENTIAL'],'Content-Type':'application/json'}))


def prepare():
    from importlib.util import spec_from_file_location,module_from_spec
    spec=spec_from_file_location('jg_build',ROOT/'scripts/build/native.py');module=module_from_spec(spec);spec.loader.exec_module(module)
    target=module.TARGET; version=json.loads((ROOT/'native/package.json').read_bytes())['version']; upstream=json.loads((ROOT/'upstream.lock').read_bytes())['sha']
    sha=os.environ['GITHUB_SHA'];run=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
    inputs={'version':version,'overlay_sha':sha,'upstream_sha':upstream,'target':target,'run_id':run}
    build_id=f'{version}-{target}-{sha}-{upstream}-{run}'
    folder=Path(tempfile.mkdtemp(prefix='jg-secret-',dir=os.environ['RUNNER_TEMP']));module.private_dir(folder)
    path=folder/'build-secret';response=gateway('prepare',inputs)
    if response.get('build_id')!=build_id or not re.fullmatch(r'[A-Za-z0-9_-]{43}',response.get('build_secret','')): raise SystemExit('Invalid registration response')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w',encoding='ascii') as f:f.write(response.pop('build_secret'))
    with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as f:f.write(f'EMRANK_BUILD_ID={build_id}\nEMRANK_BUILD_SECRET_FILE={path}\n')


def erase():
    raw=os.environ.get('EMRANK_BUILD_SECRET_FILE');
    if not raw: return
    f=Path(raw).resolve(); parent=f.parent
    if parent.parent!=Path(os.environ['RUNNER_TEMP']).resolve() or not parent.name.startswith('jg-secret-') or f.name!='build-secret': raise SystemExit('Unexpected private input path')
    f.unlink(missing_ok=True);parent.rmdir()
    with open(os.environ['GITHUB_ENV'],'a',encoding='utf-8') as out:out.write('EMRANK_BUILD_SECRET_FILE=\n')


def manifests():
    result={}; shared={}
    for platform,(target,suffix) in TARGETS.items():
        file=POOL/(platform+'.json');m=json.loads(file.read_bytes());vid=m['version']; key=f"{vid}-{target}-{m['overlay_sha']}-{m['upstream_sha']}-{m['run_id']}"
        if (m['target']!=target or m['build_id']!=key or m['issuer']!=ORIGIN or m['overlay_sha']!=os.environ['GITHUB_SHA'] or not re.fullmatch(r'(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}',vid) or set(m['packages'])!={CLI,LOADER,LOADER+'-'+suffix}): raise SystemExit('Invalid protected candidate manifest')
        for name,rec in m['packages'].items():
            f=POOL/rec['file']
            if f.parent!=POOL or f.suffix!='.tgz' or digest(f.read_bytes())!=rec['sha256'] or (name in shared and shared[name]!=rec): raise SystemExit('Candidate tarball mismatch')
            pkg=json.loads(entries(f)['package/package.json'])
            if pkg.get('private') or pkg['name']!=name or pkg['version']!=vid: raise SystemExit('Invalid public candidate package')
            shared[name]=rec
        result[platform]=(m,digest(file.read_bytes()))
    if len({(m['run_id'],m['version'],m['upstream_sha']) for m,_ in result.values()})!=1: raise SystemExit('Mixed candidate batch')
    return result,shared


def check_run():
    run=os.environ['CANDIDATE_RUN']; assert re.fullmatch('[1-9][0-9]*',run)
    repo=os.environ['GITHUB_REPOSITORY']; r=json.loads(request(f'https://api.github.com/repos/{repo}/actions/runs/{run}',headers={'Authorization':'Bearer '+os.environ['GITHUB_TOKEN'],'User-Agent':'jg-release'}))
    if not (r['event']=='workflow_dispatch' and r['head_branch']=='main' and r['head_sha']==os.environ['GITHUB_SHA'] and r['path']=='.github/workflows/release.yml' and r['conclusion']=='success' and r['head_repository']['full_name']==repo): raise SystemExit('Not a successful protected candidate run for this main SHA')


def accepted(records):
    # An approved B operator attests the actual paid test, outside CI. Missing or unknown evidence never promotes.
    receipt=json.loads(os.environ['B_ACCEPTANCE']); required={'navigation','evidence','file-assessment','doctor'}
    if receipt.get('issuer')!=ORIGIN or receipt.get('status')!='pass' or receipt.get('grants_revoked') is not True or receipt.get('policy_closed') is not True or not re.fullmatch(r'[a-f0-9]{64}',receipt.get('evidence_sha256','')): raise SystemExit('B evidence or cleanup incomplete')
    for pf,(m,h) in records.items():
        r=receipt['targets'][pf]
        if not (m['run_id'].split('-')[0]==os.environ['CANDIDATE_RUN'] and r['manifest_sha256']==h and r['real_upstream_attempts']==4 and r['flow']==('loopback' if pf=='windows' else 'manual') and r['natural_refresh']=='pass' and set(r['operations'])==required and all(v=='pass' for v in r['operations'].values())):raise SystemExit('B evidence does not cover the sealed target')


def registry(name,version,path,optional=False):
    meta=request(f'{REGISTRY}/{name.replace("/","%2f")}/{version}',missing=optional)
    if meta is None:return False
    url=json.loads(meta)['dist']['tarball']; from urllib.parse import urlsplit
    if urlsplit(url).netloc!='registry.npmjs.org' or urlsplit(url).scheme!='https' or digest(request(url))!=digest(path.read_bytes()): raise SystemExit('Registry bytes differ; stop without changing public tags')
    return True


def main():
    if os.environ.get('GITHUB_EVENT_NAME')!='workflow_dispatch' or os.environ.get('GITHUB_REF')!='refs/heads/main' or not re.fullmatch('[a-f0-9]{40}',os.environ.get('GITHUB_SHA','')): raise SystemExit('Requires protected main dispatch')
    action=sys.argv[1]
    if action=='prepare':return prepare()
    if action=='erase':return erase()
    if action=='check-run':return check_run()
    records,packages=manifests();version=records['linux'][0]['version']
    if action=='verify':
        for m,h in records.values():
            reply=gateway(m['build_id']+'/verify',{'artifact_sha256':h});assert reply['artifact_sha256']==h
        return
    accepted(records)
    if action=='gate': return
    ordered=sorted(packages,key=lambda n:2 if n==CLI else 1 if n==LOADER else 0)
    if action=='publish':
        for n in ordered:
            path=POOL/packages[n]['file']
            if not registry(n,version,path,True): subprocess.run(['npm','publish',str(path),'--access','public','--tag','candidate','--ignore-scripts','--registry',REGISTRY],check=True)
        return
    for n in ordered:registry(n,version,POOL/packages[n]['file'])
    if action=='registry': return
    if action=='promote':
        builds={m['build_id']:h for m,h in records.values()};r=gateway('release',{'version':version,'builds':builds});assert r['status']=='released' and r['version']==version and r['builds']==builds
    elif action=='tag':
        for n in ordered:subprocess.run(['npm','dist-tag','add',f'{n}@{version}','latest','--registry',REGISTRY],check=True)
    else:raise SystemExit('Unknown release step')


if __name__=='__main__':main()
