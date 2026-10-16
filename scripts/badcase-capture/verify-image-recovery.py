"""Opt-in Linux/root offline experiment. Never install components or alter shared daemon.
Start a disposable dockerd in private mount/network namespaces, then run archived SDK
initialization or scripted offline tools through it. No real model, credentials or production DB.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser()
    for name in ['image-id', 'repository-digest', 'architecture', 'node-version', 'python-version']:
        parser.add_argument('--' + name, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--scripted-evaluation', action='store_true', help='offline SDK prompt/tool loop, scripted model only')
    mode.add_argument('--model-relay', action='store_true', help='network-none Docker SDK/tools through host budget relay to synthetic loopback TLS only')
    mode.add_argument('--probe-recovery', action='store_true', help='SIGKILL own offline scheduler and explicitly recover its owned container')
    mode.add_argument('--approved-scripted-evaluation', action='store_true', help='HTTP approval to offline runner and report; no paid model')
    mode.add_argument('--workbench', action='store_true', help='isolated material review and explicit HTTP start; no paid model')
    mode.add_argument('--browser-workbench', action='store_true', help='same-run Chromium review/start/query to dedicated Docker; scripted model only')
    parser.add_argument('--captured', action='store_true', help='real synthetic collector + SQLite/HTTP seal selected into workbench; only with workbench modes')
    parser.add_argument('--operator-cli', action='store_true', help='launch the real operator CLI child; requires browser-workbench and captured')
    parser.add_argument('--browser-executable')
    parser.add_argument('--browser-library-dir')
    parser.add_argument('--browser-fontconfig')
    args = parser.parse_args()
    if args.operator_cli and not (args.browser_workbench and args.captured):
        parser.error('operator-cli requires browser-workbench and captured')
    if args.captured and not (args.workbench or args.browser_workbench or args.model_relay):
        parser.error('captured requires workbench, browser-workbench or model-relay')
    if args.browser_workbench:
        if not (args.browser_executable and args.browser_library_dir):
            parser.error('browser-workbench requires explicit browser executable and library directory')
        if not Path(args.browser_executable).is_absolute() or not Path(args.browser_executable).is_file():
            parser.error('browser executable must be an existing absolute file')
        if not Path(args.browser_library_dir).is_absolute() or not Path(args.browser_library_dir).is_dir():
            parser.error('browser library directory must be an existing absolute directory')
        if args.browser_fontconfig and (not Path(args.browser_fontconfig).is_absolute() or not Path(args.browser_fontconfig).is_file()):
            parser.error('browser fontconfig must be an existing absolute file')
    elif args.browser_executable or args.browser_library_dir or args.browser_fontconfig:
        parser.error('browser paths require browser-workbench')
    if os.geteuid() != 0:
        raise RuntimeError('explicit_root_environment_required')
    repo = Path(__file__).resolve().parents[2]
    base = Path(tempfile.mkdtemp(prefix='caff-image-recovery-', dir='/var/tmp'))
    os.chmod(base, 0o700)
    (base / 'client').mkdir()
    (base / 'daemon.json').write_text('{}')
    env = {'PATH': '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(base / 'client'), 'LANG': 'C.UTF-8'}
    source = ['docker', '--context', 'default']
    target = ['docker', '--host', 'unix://' + str(base / 'docker.sock')]
    report = {'acceptance': False, 'modelInvocations': 0}
    daemon = None
    log = (base / 'daemon.log').open('wb')

    def output(command, timeout=30):
        return subprocess.run(command, env=env, cwd=repo, check=True, timeout=timeout,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def image():
        i = json.loads(output(source + ['image', 'inspect', args.image_id]))[0]
        return {k: i.get(k) for k in ['Id', 'RepoDigests', 'RepoTags', 'Architecture', 'Os', 'RootFS', 'Config']}

    try:
        original = image()
        shared_id = json.loads(output(source + ['info', '--format', '{{json .}}']))['ID']
        if not shared_id:
            raise RuntimeError('shared_daemon_unknown')
        command = ['unshare', '--mount', '--net', '--propagation', 'private', 'dockerd',
                   '--config-file', str(base / 'daemon.json'), '--host', 'unix://' + str(base / 'docker.sock'),
                   '--data-root', str(base / 'data'), '--exec-root', str(base / 'run'),
                   '--pidfile', str(base / 'daemon.pid'), '--storage-driver', 'vfs',
                   '--bridge', 'none', '--iptables=false', '--ip6tables=false', '--ip-forward=false',
                   '--ip-masq=false', '--userland-proxy=false', '--containerd-namespace', 'caff-recovery',
                   '--containerd-plugins-namespace', 'caff-recovery-plugins']
        daemon = subprocess.Popen(command, env=env, stdout=log, stderr=log, start_new_session=True)
        deadline, info = time.monotonic() + 30, None
        while time.monotonic() < deadline:
            if daemon.poll() is not None:
                raise RuntimeError('isolated_daemon_exited')
            try:
                candidate = json.loads(output(target + ['info', '--format', '{{json .}}'], timeout=2))
                if candidate.get('ID') and candidate.get('DockerRootDir') and not candidate.get('ServerErrors'):
                    info = candidate
                    break
            except (subprocess.SubprocessError, ValueError):
                pass
            time.sleep(0.1)
        if not info or info['ID'] == shared_id or info['DockerRootDir'] != str(base / 'data') or info['Driver'] != 'vfs' or info['Images'] or info['Containers']:
            raise RuntimeError('isolated_daemon_identity_failed')
        pid = int((base / 'daemon.pid').read_text())
        if pid != daemon.pid:
            raise RuntimeError('daemon_pid_failed')
        for namespace in ['mnt', 'net']:
            if os.readlink('/proc/self/ns/' + namespace) == os.readlink('/proc/' + str(pid) + '/ns/' + namespace):
                raise RuntimeError('daemon_namespace_failed')
        script = ('verify-model-evaluation.cjs' if args.model_relay else
                  'verify-probe-recovery.cjs' if args.probe_recovery else
                  'verify-workbench.cjs' if args.workbench or args.browser_workbench else
                  'verify-approved-scripted-evaluation.cjs' if args.approved_scripted_evaluation else
                  'verify-scripted-evaluation.cjs' if args.scripted_evaluation else 'verify-image-recovery.cjs')
        node_args = ['node', str(repo / 'scripts/badcase-capture' / script)]
        for key, value in vars(args).items():
            if key not in ['model_relay', 'scripted_evaluation', 'probe_recovery', 'approved_scripted_evaluation', 'workbench', 'browser_workbench', 'browser_executable', 'browser_library_dir', 'browser_fontconfig', 'captured', 'operator_cli']:
                node_args.extend(['--' + key.replace('_', '-'), value])
        node_args.extend(['--socket', 'unix://' + str(base / 'docker.sock'), '--daemon-id', info['ID'], '--data-root', str(base / 'data')])
        if args.captured:
            node_args.append('--captured')
        if args.operator_cli:
            node_args.append('--operator-cli')
        if args.browser_workbench:
            node_args.extend(['--browser-docker', '--browser-executable', args.browser_executable,
                              '--browser-library-dir', args.browser_library_dir,
                              '--parent-netns', os.readlink('/proc/self/ns/net')])
            if args.browser_fontconfig:
                node_args.extend(['--browser-fontconfig', args.browser_fontconfig])
            # Browser and HTTP server share only a fresh namespace's loopback.
            # Docker CLI uses unix sockets; task containers retain network=none.
            node_args = ['unshare', '--net', '--', 'sh', '-c',
                         'ip link set lo up && exec "$@"', 'caff-browser-workbench', *node_args]
        # SDK never runs here: Node is only the trusted host scheduler. All SDK/tools
        # run in unprivileged, network-none containers checked by the existing probe.
        report['diagnostic'] = json.loads(output(node_args, timeout=300))
        if output(target + ['ps', '-aq']).strip():
            raise RuntimeError('container_cleanup_failed')
        if image() != original or json.loads(output(source + ['info', '--format', '{{json .}}']))['ID'] != shared_id:
            raise RuntimeError('shared_identity_changed')
        loaded = json.loads(output(target + ['image', 'inspect', args.image_id]))[0]
        for key in ['Id', 'Architecture', 'Os', 'RootFS', 'Config']:
            if loaded[key] != original[key]:
                raise RuntimeError('recovered_image_changed')
        report.update({'ok': True, 'sharedImageUnchanged': True, 'separateNetworkAndMountNamespaces': True,
                       'remainingContainers': 0, 'loadedConfigAndLayersMatch': True,
                       'observedRepositoryDigests': loaded.get('RepoDigests')})
    except Exception as exc:
        # No raw daemon/stdout content or credentials in public reports.
        report.update({'ok': False, 'error': type(exc).__name__})
        if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
            # Only known verifier stage codes, never raw stderr/assertion data.
            stages = ['prepare', 'cli-start', 'browser-launch', 'browser-preview', 'browser-approve',
                      'browser-start', 'browser-report', 'rebuild', 'evidence']
            for stage in stages:
                if exc.stderr.strip() == ('workbench_verification_failed:' + stage).encode():
                    report['diagnosticFailureStage'] = stage
            for stage in ['prepare', 'restore', 'definitions', 'tls', 'run-fresh', 'run-resume', 'evidence-fresh', 'evidence-resume']:
                if exc.stderr.strip() == ('model_evaluation_verification_failed:' + stage).encode():
                    report['diagnosticFailureStage'] = stage
            for stage in ['prepare', 'restore', 'before-create', 'before-start', 'running-fresh', 'running-resume', 'reserved', 'recover', 'evidence']:
                if exc.stderr.strip() == ('probe_recovery_verification_failed:' + stage).encode():
                    report['diagnosticFailureStage'] = stage
    finally:
        if daemon is not None:
            try:
                os.killpg(daemon.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                daemon.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(daemon.pid, signal.SIGKILL)
                daemon.wait(timeout=10)
            report['daemonExitCode'] = daemon.returncode
        log.close()
        leftovers = []
        for p in Path('/proc').iterdir():
            if not p.name.isdecimal() or int(p.name) == os.getpid():
                continue
            try:
                if str(base).encode() in (p / 'cmdline').read_bytes():
                    leftovers.append(int(p.name))
            except OSError:
                pass
        mounts = output(['findmnt', '-rn', '-o', 'TARGET']).decode().splitlines()
        active_mounts = [m for m in mounts if m == str(base) or m.startswith(str(base) + '/')]
        report.update({'remainingOwnedProcesses': len(leftovers), 'remainingHostMounts': len(active_mounts)})
        if not leftovers and not active_mounts:
            shutil.rmtree(base)
            report['temporaryDirectoryRemoved'] = not base.exists()
        else:
            report['temporaryDirectoryRemoved'] = False
        print(json.dumps(report, indent=2), flush=True)
    return 0 if report.get('ok') and report.get('temporaryDirectoryRemoved') else 1


if __name__ == '__main__':
    raise SystemExit(main())
