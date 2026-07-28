'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { assertSafeRedisPort } = require('./config');
const { RespClient } = require('./resp-client');

function findRedisServer(explicitPath) {
  const configured = explicitPath || process.env.REDIS_SERVER_PATH;
  if (configured && fs.existsSync(configured)) return path.resolve(configured);
  const command = configured || 'redis-server';
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? command : null;
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = assertSafeRedisPort(address.port);
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RedisProcessManager {
  constructor({ directory, durability = 'balanced', port, redisServerPath }) {
    if (!directory) throw new Error('Redis benchmark directory is required');
    if (durability !== 'balanced' && durability !== 'strict') {
      throw new Error(`Unsupported Redis durability profile: ${durability}`);
    }
    this.directory = path.resolve(directory);
    this.durability = durability;
    this.port = port === undefined ? null : assertSafeRedisPort(port);
    this.redisServerPath = redisServerPath;
    this.child = null;
    this.hasStarted = false;
  }

  assertInitialDirectoryIsEmpty() {
    fs.mkdirSync(this.directory, { recursive: true });
    if (fs.readdirSync(this.directory).length > 0) {
      throw new Error('Redis benchmark requires an empty data directory on first start');
    }
  }

  async start() {
    if (this.child) throw new Error('Redis benchmark process is already running');
    if (!this.hasStarted) this.assertInitialDirectoryIsEmpty();
    const executable = findRedisServer(this.redisServerPath);
    if (!executable) throw new Error('redis-server is unavailable; set REDIS_SERVER_PATH or add it to PATH');
    if (!this.port) this.port = await allocateLoopbackPort();

    const appendfsync = this.durability === 'strict' ? 'always' : 'everysec';
    const args = [
      '--bind', '127.0.0.1',
      '--protected-mode', 'yes',
      '--port', String(this.port),
      '--dir', this.directory,
      '--dbfilename', 'dump.rdb',
      '--appendonly', 'yes',
      '--appendfilename', 'appendonly.aof',
      '--appendfsync', appendfsync,
      '--save', '60 1',
      '--databases', '1',
      '--logfile', 'redis.log',
      '--daemonize', 'no',
    ];
    const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        this.child = null;
        throw new Error(`redis-server exited during startup with code ${child.exitCode}`);
      }
      const client = new RespClient({ port: this.port, connectTimeoutMs: 250 });
      try {
        await client.connect();
        const pong = await client.sendCommand(['PING']);
        client.close();
        if (pong === 'PONG') {
          this.hasStarted = true;
          return;
        }
      } catch {
        client.close();
      }
      await delay(25);
    }

    await this.killAbrupt();
    throw new Error(`Timed out waiting for redis-server on 127.0.0.1:${this.port}`);
  }

  async waitForExit(timeoutMs = 5_000) {
    if (!this.child || this.child.exitCode !== null) return;
    let timeout;
    try {
      const result = await Promise.race([
        this.exitPromise,
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (result === 'timeout') {
        throw new Error(`redis-server PID ${this.child.pid} did not exit within ${timeoutMs}ms`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop({ graceful = true } = {}) {
    if (!this.child) return;
    const child = this.child;
    if (graceful && child.exitCode === null) {
      const client = new RespClient({ port: this.port, connectTimeoutMs: 500 });
      try {
        await client.connect();
        await client.sendCommand(['SHUTDOWN', 'SAVE']);
      } catch {
        // Redis closes the control connection while processing SHUTDOWN.
      } finally {
        client.close();
      }
    }
    try {
      await this.waitForExit(5_000);
    } catch (error) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await this.waitForExit(5_000);
      if (!graceful) throw error;
    } finally {
      this.child = null;
    }
  }

  async killAbrupt() {
    if (!this.child) return;
    const child = this.child;
    if (child.exitCode === null) child.kill('SIGKILL');
    await this.waitForExit(5_000);
    this.child = null;
  }

  get pid() {
    return this.child ? this.child.pid : null;
  }
}

module.exports = { RedisProcessManager, allocateLoopbackPort, findRedisServer };
