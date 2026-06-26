import { spawn } from 'child_process';

const PROJECT_ROOT = process.env.E2E_PROJECT_ROOT || process.cwd();

export class RealAgent {
  constructor(serverUrl, workDir = '/tmp/smoke-test-workdir') {
    this.serverUrl = serverUrl;
    this.workDir = workDir;
    this.process = null;
  }

  async start() {
    this.process = spawn('node', ['agent/index.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        SERVER_URL: this.serverUrl.replace('http', 'ws'),
        AGENT_NAME: 'smoke-test-agent',
        WORK_DIR: this.workDir,
        SKIP_AUTH: 'true'
      },
      stdio: 'pipe'
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Agent start timeout')), 15000);
      this.process.stdout.on('data', (data) => {
        const text = data.toString();
        if (text.includes('Registered as agent')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise(resolve => this.process.on('exit', resolve));
      this.process = null;
    }
  }
}
