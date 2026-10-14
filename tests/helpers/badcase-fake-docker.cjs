// Deterministic Docker protocol fixture, NOT isolation or execution evidence.
module.exports = function fakeDocker(image, overrides = {}) {
  const calls = [];
  let name, owner, cmd, created = false;
  const info = () => ({ Id: 'b'.repeat(64), Image: image.imageId, Config: { Labels: { 'caff.badcase.offline': owner }, User: '65534:65534', Entrypoint: ['/usr/bin/env'], WorkingDir: '/work', Cmd: cmd, Volumes: null }, Mounts: [], HostConfig: { LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' }, AutoRemove: false, NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'], Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, PidsLimit: 64, Binds: null, PortBindings: {}, Devices: [], DeviceRequests: null, PidMode: '', IpcMode: 'private', Tmpfs: { '/work': 'rw,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700', '/tmp': 'rw,nosuid,nodev,noexec,size=16m,uid=65534,gid=65534,mode=0700' } }, State: { Running: false, ExitCode: 0, OOMKilled: false } });
  const run = async (args, options) => {
    calls.push({ args, options });
    const result = { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'context') result.stdout = JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    else if (args[0] === 'image') result.stdout = JSON.stringify([{ Id: image.imageId, RepoDigests: [image.repositoryDigest], Architecture: image.architecture, Os: 'linux', Config: { Volumes: null, OnBuild: null } }]);
    else if (args[0] === 'create') {
      name = args[args.indexOf('--name') + 1]; owner = args[args.indexOf('--label') + 1].split('=')[1]; cmd = args.slice(args.indexOf(image.imageId) + 1); created = true; result.stdout = 'b'.repeat(64);
    } else if (args[0] === 'inspect') result.stdout = JSON.stringify([info()]);
    else if (args[0] === 'start') result.stdout = 'ok\n';
    else if (args[0] === 'rm') created = false;
    else if (args[0] === 'ps') result.stdout = created ? 'b'.repeat(64) + '\n' : '';
    if (overrides.change) await overrides.change(args, result, { info, name, owner, created, options });
    return result;
  };
  return { run, calls };
};
