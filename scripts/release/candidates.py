"""Seal the exact same four tarballs for both platforms and install from those bytes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

TARGETS = {'windows': ('x86_64-pc-windows-msvc', 'win32-x64-msvc'), 'linux': ('x86_64-unknown-linux-gnu','linux-x64-gnu')}
LOADER = '@emrank/jevgrep-native'
CLI = '@emrank/jevgrep'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def entries(path):
    with tarfile.open(path,'r:gz') as tar:
        files = {}
        for member in tar.getmembers():
            if member.isdir(): continue
            if not member.isfile() or not member.name.startswith('package/') or '..' in Path(member.name).parts or member.name in files:
                raise ValueError('Unexpected package archive member')
            files[member.name] = tar.extractfile(member).read()
        return files


def write(path,value):
    path.write_bytes((json.dumps(value,indent=2,sort_keys=True)+'\n').encode())


def seal(a):
    a.out.mkdir(parents=True,exist_ok=False)
    archives={}; binaries={}; records={}
    for platform, (target,suffix) in TARGETS.items():
        base = getattr(a,platform); packages={}
        for path in base.glob('*.tgz'):
            files=entries(path); pkg=json.loads(files['package/package.json']); name=pkg['name']
            if name not in (CLI,LOADER,LOADER+'-'+suffix) or name in packages or pkg['version']!=a.version or bool(pkg.get('private'))!=a.local:
                raise ValueError('Unexpected package name/version/visibility')
            if name==LOADER and pkg['optionalDependencies']!={LOADER+'-'+s:a.version for _,s in TARGETS.values()}: raise ValueError('Loader version mismatch')
            if name==CLI and pkg['dependencies'].get(LOADER)!=a.version: raise ValueError('CLI dependency mismatch')
            if name.startswith(LOADER+'-'): binaries[platform]=digest(files['package/jevgrep-native.node'])
            if name in archives and files!=entries(archives[name]): raise ValueError('Shared archives have different contents: '+name)
            # Always choose Linux's common archives, then test these exact bytes on Windows as well.
            if platform=='linux' or name not in archives: archives[name]=path
            packages[name]=path
        if len(packages)!=3: raise ValueError('Expected three packages per build')
    for name,path in archives.items():
        shutil.copyfile(path,a.out/path.name)
        records[name]={'file':path.name,'sha256':digest(path.read_bytes())}
    for platform,(target,suffix) in TARGETS.items():
        build_id=f'{a.version}-{target}-{a.overlay}-{a.upstream}-{a.run}'
        write(a.out/(platform+'.json'), dict(build_id=build_id, target=target,version=a.version,run_id=a.run,issuer='https://127.0.0.1:15816' if a.local else 'https://emrank.tech',overlay_sha=a.overlay,upstream_sha=a.upstream,native_sha256=binaries[platform],packages={n:records[n] for n in (CLI,LOADER,LOADER+'-'+suffix)}))
    print('Sealed four archives and two target manifests.')


def install(a):
    platform='windows' if os.name=='nt' else 'linux'; manifest=json.loads((a.pool/(platform+'.json')).read_bytes()); suffix=TARGETS[platform][1]
    overrides={}; archives={}
    for pf in TARGETS:
        for name,rec in json.loads((a.pool/(pf+'.json')).read_bytes())['packages'].items():
            path=(a.pool/rec['file']).resolve()
            if path.parent!=a.pool.resolve() or digest(path.read_bytes())!=rec['sha256'] or (name in archives and archives[name]!=rec): raise ValueError('Tarball digest mismatch')
            archives[name]=rec; overrides[name]='file:'+path.as_posix()
    a.dest = a.dest.resolve()
    a.dest.mkdir(parents=True,exist_ok=False)
    write(a.dest/'package.json',{'private':True,'dependencies':{CLI:overrides[CLI]},'overrides':overrides})
    env={**os.environ,'EMRANK_HOME':str(a.dest/'credentials'),'XDG_CONFIG_HOME':str(a.dest/'config'),'XDG_CACHE_HOME':str(a.dest/'cache'),'BUN_INSTALL_CACHE_DIR':str(a.dest/'bun-cache')}
    subprocess.run(['bun','install','--ignore-scripts'],cwd=a.dest,env=env,check=True)
    installed=a.dest/'node_modules'; lib=installed/(LOADER+'-'+suffix)/'jevgrep-native.node'
    if digest(lib.read_bytes())!=manifest['native_sha256']: raise ValueError('Installed native binary mismatch')
    info=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {buildInfo,configuredIssuer} from '@emrank/jevgrep-native'; console.log(JSON.stringify({...buildInfo(),issuer:configuredIssuer()}))"],cwd=a.dest,env=env))
    version=subprocess.check_output(['node',str(installed/CLI/'dist/bin/index.js'),'--version'],cwd=a.dest,env=env,text=True).strip()
    if version!=manifest['version'] or info!={'id':manifest['build_id'],'version':version,'kind':'A' if manifest['issuer'].startswith('https://127.') else 'release','issuer':manifest['issuer']}: raise ValueError('Installed build, version or origin mismatch')
    print('Installed and verified',platform,version,manifest['native_sha256'])


if __name__=='__main__':
    parser=argparse.ArgumentParser(); commands=parser.add_subparsers(dest='cmd',required=True)
    c=commands.add_parser('seal'); c.add_argument('--local',action='store_true');
    for name in ('windows','linux','out'): c.add_argument('--'+name,required=True,type=Path)
    for name in ('version','overlay','upstream','run'): c.add_argument('--'+name,required=True)
    c=commands.add_parser('install'); c.add_argument('pool',type=Path); c.add_argument('dest',type=Path)
    a=parser.parse_args(); (seal if a.cmd=='seal' else install)(a)
