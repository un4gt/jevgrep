"""Build a registered target exactly once in a private, uncached Cargo directory."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
NATIVE = ROOT / 'native'
WINDOWS = os.name == 'nt'
TARGET = 'x86_64-pc-windows-msvc' if WINDOWS else 'x86_64-unknown-linux-gnu'


def private_dir(directory):
    if WINDOWS:
        # Prevent inherited ACLs on CI scratch directories. A new mkdtemp is empty.
        sid = subprocess.check_output(['whoami', '/user', '/fo', 'csv', '/nh'], encoding='utf-8').strip().split(',')[-1].strip('"')
        subprocess.run(['icacls', str(directory), '/inheritance:r', '/grant:r', f'*{sid}:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], stdout=subprocess.DEVNULL, check=True)
    else:
        directory.chmod(0o700)


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    for mode in ('fixture','unregistered','release','a'):
        group.add_argument('--'+mode, action='store_true')
    args = parser.parse_args()
    registered = args.release or args.a
    fixture = not (registered or args.unregistered)
    env = os.environ.copy()
    version = '0.1.0' if args.a else json.loads((NATIVE/'package.json').read_text())['version']
    env.pop('EMRANK_COMPILED_ISSUER', None)
    if args.release:
        if env.get('EMRANK_ISSUER') != 'https://emrank.tech':
            raise SystemExit('Protected release requires the production issuer')
        env['EMRANK_COMPILED_ISSUER'] = env['EMRANK_ISSUER']
    elif args.a:
        env['EMRANK_COMPILED_ISSUER'] = 'https://127.0.0.1:15816'
    if registered:
        if env.get('EMRANK_TARGET',TARGET) != TARGET or not env.get('EMRANK_BUILD_ID','').startswith(f'{version}-{TARGET}-') or not Path(env.get('EMRANK_BUILD_SECRET_FILE','')).is_file():
            raise SystemExit('Build inputs do not match the registered version/target')
        if args.a and not Path(env.get('EMRANK_A_CA_FILE','')).is_file():
            raise SystemExit('A requires its dedicated public CA')
    elif any(env.get(k) for k in ['EMRANK_BUILD_ID','EMRANK_BUILD_SECRET_FILE','EMRANK_A_CA_FILE']):
        raise SystemExit('Compatibility builds must not receive release material')
    if not args.a and env.get('EMRANK_A_CA_FILE'):
        raise SystemExit('A trust roots are forbidden in release/fixture builds')
    with tempfile.TemporaryDirectory(prefix='jg-build-') as temp:
        scratch = Path(temp); private_dir(scratch)
        source = NATIVE
        cargo = 'cargo'; target_dir = NATIVE/'target'
        if registered:
            cargo = subprocess.check_output(['rustup','which','cargo'],text=True).strip()
            env.update(RUSTC=subprocess.check_output(['rustup','which','rustc'],text=True).strip(), RUSTC_WRAPPER='', RUSTC_WORKSPACE_WRAPPER='', CARGO_INCREMENTAL='0', CARGO_ENCODED_RUSTFLAGS='')
            for name in ('SCCACHE_DIR','SCCACHE_BUCKET','RUSTFLAGS','EMRANK_RELEASE_CREDENTIAL','NODE_AUTH_TOKEN','NPM_CONFIG_TOKEN'):
                env.pop(name,None)
            target_dir = scratch/'target'
            source = scratch/'native'; source.mkdir()
            for name in ['Cargo.toml','Cargo.lock','build.rs']:
                shutil.copyfile(NATIVE/name, source/name)
            for name in ['src','fixtures','policies']:
                shutil.copytree(NATIVE/name,source/name)
            if args.a:
                for name,pattern in [('Cargo.toml',r'(\[package\][\s\S]*?version = ")[^"]+'),('Cargo.lock',r'(name = "emrank-jevgrep-native"\nversion = ")[^"]+')]:
                    file = source/name
                    text, count = re.subn(pattern, lambda m:m[1]+version,file.read_text(),count=1)
                    if count != 1: raise SystemExit('A manifest version missing')
                    file.write_text(text)
        env['CARGO_TARGET_DIR'] = str(target_dir)
        cmd = [cargo, 'build', '--release','--locked','-j','2','--manifest-path',str(source/'Cargo.toml')]
        if fixture or args.a: cmd += ['--features','test-http-loopback' if fixture else 'kiri-https']
        subprocess.run(cmd,cwd=source,env=env,check=True)
        library = 'emrank_jevgrep_native.dll' if WINDOWS else 'libemrank_jevgrep_native.so'
        output = Path(env.get('EMRANK_BINARY_DIR',str(NATIVE))); output.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(target_dir/'release'/library,output/'jevgrep-native.node')


if __name__ == '__main__':
    main()
