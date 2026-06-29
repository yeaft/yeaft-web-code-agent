/**
 * E2E Test: Login Flow
 *
 * Tests authentication with SKIP_AUTH=false server instance.
 * Creates a temporary user via the create-user CLI, then tests:
 *   - Login form submission and error messages
 *   - Successful authentication redirects to ChatPage
 *   - Invalid credentials show error
 */
import { test as base, expect } from '@playwright/test';
import { spawn, execSync } from 'child_process';
import fs from 'fs';

const PROJECT_ROOT = process.env.E2E_PROJECT_ROOT || process.cwd();

class AuthTestServer {
  constructor(port) {
    this.port = port;
    this.process = null;
    this.url = `http://localhost:${port}`;
    this.dbDir = `/tmp/e2e-auth-test-${port}`;
    this.env = {
      ...process.env,
      PORT: String(port),
      SKIP_AUTH: 'false',
      NODE_ENV: 'test',
      TEST_DB_DIR: this.dbDir,
      JWT_SECRET: `test-jwt-secret-${port}`,
      TOTP_ENABLED: 'false',
    };
  }

  async start() {
    if (fs.existsSync(this.dbDir)) {
      fs.rmSync(this.dbDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.dbDir, { recursive: true });

    this.process = spawn('node', ['server/index.js'], {
      cwd: PROJECT_ROOT,
      env: this.env,
      stdio: 'pipe'
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth server start timeout')), 15000);
      this.process.stdout.on('data', (data) => {
        if (data.toString().includes('Server running on')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process.stderr.on('data', (data) => {
        if (data.toString().includes('EADDRINUSE')) {
          clearTimeout(timeout);
          reject(new Error(`Port ${this.port} already in use`));
        }
      });
      this.process.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  createUser(username, password) {
    execSync(
      `node server/create-user.js "${username}" "${password}"`,
      { cwd: PROJECT_ROOT, env: this.env, stdio: 'pipe', timeout: 10000 }
    );
  }

  async stop() {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise(resolve => this.process.on('exit', resolve));
      this.process = null;
    }
    if (fs.existsSync(this.dbDir)) {
      fs.rmSync(this.dbDir, { recursive: true, force: true });
    }
  }
}

const test = base.extend({
  authServer: [async ({}, use) => {
    const port = 3600 + Math.floor(Math.random() * 100);
    const server = new AuthTestServer(port);
    await server.start();
    await use(server);
    await server.stop();
  }, { scope: 'worker' }],
});

test.describe('Login Flow', () => {
  const testUsername = 'e2e-test-user';
  const testPassword = 'TestPassword123!';

  test.beforeAll(async ({ authServer }) => {
    authServer.createUser(testUsername, testPassword);
  });

  test('should show login form when auth is required', async ({ page, authServer }) => {
    await page.goto(authServer.url);
    await expect(page.locator('.login-page')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.login-container')).toBeVisible();
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
    await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();
    await expect(page.locator('.login-container button').first()).toBeVisible();
  });

  test('should show error for invalid credentials', async ({ page, authServer }) => {
    await page.goto(authServer.url);
    await page.waitForSelector('.login-page', { timeout: 10000 });

    await page.fill('input[autocomplete="username"]', 'nonexistent-user');
    await page.fill('input[autocomplete="current-password"]', 'wrongpassword');
    await page.locator('.login-container button').first().click();

    await expect(page.locator('.login-container .error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.login-container .error')).toContainText(/invalid|error|failed/i);
    await expect(page.locator('.login-page')).toBeVisible();
  });

  test('should show error for empty credentials', async ({ page, authServer }) => {
    await page.goto(authServer.url);
    await page.waitForSelector('.login-page', { timeout: 10000 });

    await page.locator('.login-container button').first().click();

    await expect(page.locator('.login-container .error')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.login-page')).toBeVisible();
  });

  test('should login successfully with valid credentials and navigate to chat', async ({ page, authServer }) => {
    await page.goto(authServer.url);
    await page.waitForSelector('.login-page', { timeout: 10000 });

    await page.fill('input[autocomplete="username"]', testUsername);
    await page.fill('input[autocomplete="current-password"]', testPassword);
    await page.locator('.login-container button').first().click();

    await expect(page.locator('.chat-page')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.login-page')).not.toBeVisible();
  });

  test('should persist session after page refresh', async ({ page, authServer }) => {
    await page.goto(authServer.url);
    await page.waitForSelector('.login-page', { timeout: 10000 });

    await page.fill('input[autocomplete="username"]', testUsername);
    await page.fill('input[autocomplete="current-password"]', testPassword);
    await page.locator('.login-container button').first().click();
    await expect(page.locator('.chat-page')).toBeVisible({ timeout: 15000 });

    await page.reload();

    await expect(page.locator('.chat-page')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.login-page')).not.toBeVisible();
  });
});
