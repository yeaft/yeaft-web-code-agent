import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Tests for Windows agent upgrade flow (cli.js upgradeWindows + upgrade-worker-template.js retryOp).
 *
 * Verifies:
 *  1. upgradeWindows() generates a correct bat script and exits
 *  2. retryOp() correctly retries on EBUSY/EPERM/EACCES and throws on other errors
 *  3. Unix upgrade path remains a simple execSync call
 */

// ---------------------------------------------------------------------------
// retryOp – extracted from upgrade-worker-template.js for direct testing
// ---------------------------------------------------------------------------
function retryOp(fn, label, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      const isLockErr = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES';
      if (!isLockErr || i === maxRetries) throw err;
      // In tests we skip the busy-wait delay
    }
  }
}

// ---------------------------------------------------------------------------
// upgradeWindows – bat script generation logic extracted from cli.js
// Updated to match PR #244: diagnostic timestamps, PM2 handling, VBS cleanup
// ---------------------------------------------------------------------------
function generateBatLines({ pid, pkgSpec, logPath, batPath, vbsPath, isPm2, ecoPath, currentVersion, latestVersion }) {
  const batLines = [
    '@echo off',
    'setlocal',
    `set PID=${pid}`,
    `set PKG=${pkgSpec}`,
    `set LOGFILE=${logPath}`,
    `set MAX_WAIT=30`,
    `set COUNT=0`,
    '',
    ':: Change to temp dir to avoid EBUSY on cwd',
    'cd /d "%TEMP%"',
    '',
    'echo [Upgrade] Started at %date% %time% > "%LOGFILE%"',
    `echo [Upgrade] Version: ${currentVersion} -> ${latestVersion} >> "%LOGFILE%"`,
    `echo [Upgrade] PM2 managed: ${isPm2 ? 'yes (deleted pre-exit)' : 'no'} >> "%LOGFILE%"`,
    'echo [Upgrade] Waiting for CLI process (PID %PID%) to exit... >> "%LOGFILE%"',
    '',
    ':WAIT_LOOP',
    'tasklist /FI "PID eq %PID%" /NH 2>NUL | findstr /C:"%PID%" >NUL',
    'if errorlevel 1 goto PID_EXITED',
    'set /A COUNT+=1',
    'if %COUNT% GEQ %MAX_WAIT% (',
    '  echo [Upgrade] Timeout waiting for PID %PID% to exit after %MAX_WAIT%s >> "%LOGFILE%"',
    '  goto PID_EXITED',
    ')',
    'ping -n 3 127.0.0.1 >NUL',
    'goto WAIT_LOOP',
    ':PID_EXITED',
    '',
    ':: Extra wait for file locks to release',
    'echo [Upgrade] Process exited at %time%, waiting for file locks... >> "%LOGFILE%"',
    'ping -n 5 127.0.0.1 >NUL',
    '',
    'echo [Upgrade] Running npm install -g %PKG%... >> "%LOGFILE%"',
    'call npm install -g %PKG% >> "%LOGFILE%" 2>&1',
    'if not "%errorlevel%"=="0" (',
    '  echo [Upgrade] npm install failed with exit code %errorlevel% at %time% >> "%LOGFILE%"',
    '  goto PM2_RESTART',
    ')',
    'echo [Upgrade] npm install succeeded at %time% >> "%LOGFILE%"',
  ];

  // PM2 re-registration after upgrade
  batLines.push('', ':PM2_RESTART');
  if (isPm2) {
    batLines.push(
      'echo [Upgrade] Re-registering agent via PM2... >> "%LOGFILE%"',
      `if exist "${ecoPath}" (`,
      `  call pm2 start "${ecoPath}" >> "%LOGFILE%" 2>&1`,
      '  call pm2 save >> "%LOGFILE%" 2>&1',
      '  echo [Upgrade] PM2 app re-registered at %time% >> "%LOGFILE%"',
      ') else (',
      '  echo [Upgrade] WARNING: ecosystem.config.cjs not found, PM2 not restarted >> "%LOGFILE%"',
      ')',
    );
  }

  batLines.push(
    '',
    'echo [Upgrade] Finished at %time% >> "%LOGFILE%"',
    ':CLEANUP',
    `del /F /Q "${vbsPath}" 2>NUL`,
    `del /F /Q "${batPath}" 2>NUL`,
  );

  return batLines;
}

// ---------------------------------------------------------------------------
// VBScript wrapper generation – extracted from cli.js (PR #244)
// Fully detaches the bat process from the parent via WshShell.Run
// ---------------------------------------------------------------------------
function generateVbsLines(batPath) {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run """${batPath}""", 0, False`,
  ];
}

// =========================================================================
// Test: retryOp
// =========================================================================
describe('retryOp — file lock retry logic', () => {
  it('should return value on first success', () => {
    const result = retryOp(() => 42, 'test-op');
    expect(result).toBe(42);
  });

  it('should retry on EBUSY and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) {
        const err = new Error('busy');
        err.code = 'EBUSY';
        throw err;
      }
      return 'ok';
    };
    expect(retryOp(fn, 'ebusy-test')).toBe('ok');
    expect(calls).toBe(3);
  });

  it('should retry on EPERM and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) {
        const err = new Error('permission');
        err.code = 'EPERM';
        throw err;
      }
      return 'done';
    };
    expect(retryOp(fn, 'eperm-test')).toBe('done');
    expect(calls).toBe(2);
  });

  it('should retry on EACCES and succeed', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) {
        const err = new Error('access');
        err.code = 'EACCES';
        throw err;
      }
      return 'done';
    };
    expect(retryOp(fn, 'eacces-test')).toBe('done');
    expect(calls).toBe(2);
  });

  it('should throw immediately on non-lock errors (e.g. ENOENT)', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    };
    expect(() => retryOp(fn, 'enoent-test')).toThrow('not found');
    expect(calls).toBe(1); // no retry
  });

  it('should throw after maxRetries exhausted on lock errors', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    expect(() => retryOp(fn, 'exhaust-test', 3)).toThrow('busy');
    expect(calls).toBe(4); // initial + 3 retries
  });

  it('should respect custom maxRetries', () => {
    let calls = 0;
    const fn = () => {
      calls++;
      const err = new Error('busy');
      err.code = 'EBUSY';
      throw err;
    };
    expect(() => retryOp(fn, 'custom-max', 1)).toThrow('busy');
    expect(calls).toBe(2); // initial + 1 retry
  });

  it('should return undefined if fn returns nothing', () => {
    const result = retryOp(() => {}, 'void-op');
    expect(result).toBeUndefined();
  });
});

// =========================================================================
// Test: Windows bat script generation
// =========================================================================
describe('upgradeWindows — bat script generation', () => {
  const params = {
    pid: 12345,
    pkgSpec: '@yeaft/webchat-agent@1.2.3',
    logPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\logs\\upgrade.log',
    batPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.bat',
    vbsPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.vbs',
    isPm2: false,
    ecoPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\ecosystem.config.cjs',
    currentVersion: '1.0.0',
    latestVersion: '1.2.3',
  };

  let batLines;
  let batContent;

  beforeEach(() => {
    batLines = generateBatLines(params);
    batContent = batLines.join('\r\n');
  });

  it('should start with @echo off', () => {
    expect(batLines[0]).toBe('@echo off');
  });

  it('should embed the current PID', () => {
    expect(batContent).toContain(`set PID=${params.pid}`);
  });

  it('should embed the package spec', () => {
    expect(batContent).toContain(`set PKG=${params.pkgSpec}`);
  });

  it('should embed the log file path', () => {
    expect(batContent).toContain(`set LOGFILE=${params.logPath}`);
  });

  it('should change to TEMP dir to avoid EBUSY', () => {
    expect(batContent).toContain('cd /d "%TEMP%"');
  });

  it('should have a wait loop checking for PID exit', () => {
    expect(batContent).toContain(':WAIT_LOOP');
    expect(batContent).toContain('tasklist /FI "PID eq %PID%"');
    expect(batContent).toContain(':PID_EXITED');
  });

  it('should use findstr instead of find for PID check', () => {
    expect(batContent).toContain('findstr /C:"%PID%"');
    expect(batContent).not.toContain('| find /I');
  });

  it('should have a max wait timeout', () => {
    expect(batContent).toContain('set MAX_WAIT=30');
    expect(batContent).toContain('if %COUNT% GEQ %MAX_WAIT%');
  });

  it('should call npm install -g with PKG variable', () => {
    expect(batContent).toContain('call npm install -g %PKG%');
  });

  it('should check npm exit code and log failure', () => {
    expect(batContent).toContain('if not "%errorlevel%"=="0"');
    expect(batContent).toContain('npm install failed with exit code');
  });

  it('should self-delete bat and vbs files at the end', () => {
    expect(batContent).toContain(`del /F /Q "${params.batPath}"`);
    expect(batContent).toContain(`del /F /Q "${params.vbsPath}"`);
  });

  it('should use CRLF line endings', () => {
    expect(batContent).toContain('\r\n');
    const lines = batContent.split('\r\n');
    expect(lines.length).toBeGreaterThan(10);
  });

  it('should use ping for delay instead of timeout (more compatible)', () => {
    expect(batContent).toContain('ping -n 3 127.0.0.1 >NUL');
    expect(batContent).not.toContain('timeout /t');
  });

  // --- PR #244: Diagnostic timestamps ---
  it('should log version transition info', () => {
    expect(batContent).toContain(`Version: ${params.currentVersion} -> ${params.latestVersion}`);
  });

  it('should log PM2 managed status', () => {
    expect(batContent).toContain('PM2 managed: no');
  });

  it('should log timestamp when process exits', () => {
    expect(batContent).toContain('Process exited at %time%');
  });

  it('should log npm result with timestamp', () => {
    expect(batContent).toContain('npm install succeeded at %time%');
    expect(batContent).toContain('npm install failed with exit code %errorlevel% at %time%');
  });

  it('should wait extra time for file locks after PID exit', () => {
    expect(batContent).toContain('waiting for file locks');
    expect(batContent).toContain('ping -n 5 127.0.0.1 >NUL');
  });

  it('should have PM2_RESTART and CLEANUP labels', () => {
    expect(batContent).toContain(':PM2_RESTART');
    expect(batContent).toContain(':CLEANUP');
  });

  // --- Non-PM2: no PM2 re-registration lines ---
  it('should not include PM2 re-registration when isPm2 is false', () => {
    expect(batContent).not.toContain('Re-registering agent via PM2');
    expect(batContent).not.toContain('pm2 start');
  });

  it('should log finished timestamp', () => {
    expect(batContent).toContain('Finished at %time%');
  });
});

// =========================================================================
// Test: Bat script PM2 re-registration (isPm2 = true)
// =========================================================================
describe('upgradeWindows — bat script with PM2 re-registration', () => {
  const pm2Params = {
    pid: 99999,
    pkgSpec: '@yeaft/webchat-agent@2.0.0',
    logPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\logs\\upgrade.log',
    batPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.bat',
    vbsPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.vbs',
    isPm2: true,
    ecoPath: 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\ecosystem.config.cjs',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
  };

  let batContent;
  beforeEach(() => {
    batContent = generateBatLines(pm2Params).join('\r\n');
  });

  it('should include PM2 re-registration section when isPm2 is true', () => {
    expect(batContent).toContain('Re-registering agent via PM2');
  });

  it('should log PM2 managed status as yes', () => {
    expect(batContent).toContain('PM2 managed: yes (deleted pre-exit)');
  });

  it('should check for ecosystem.config.cjs existence before pm2 start', () => {
    expect(batContent).toContain(`if exist "${pm2Params.ecoPath}"`);
  });

  it('should call pm2 start with ecosystem config path', () => {
    expect(batContent).toContain(`call pm2 start "${pm2Params.ecoPath}"`);
  });

  it('should call pm2 save after re-registration', () => {
    expect(batContent).toContain('call pm2 save');
  });

  it('should warn when ecosystem config is not found', () => {
    expect(batContent).toContain('ecosystem.config.cjs not found, PM2 not restarted');
  });

  it('should goto PM2_RESTART on npm failure (still re-register)', () => {
    expect(batContent).toContain('goto PM2_RESTART');
  });
});

// =========================================================================
// Test: VBScript wrapper generation
// =========================================================================
describe('VBScript wrapper generation', () => {
  const batPath = 'C:\\Users\\test\\AppData\\Roaming\\yeaft-agent\\upgrade-cli.bat';
  let vbsLines;
  let vbsContent;

  beforeEach(() => {
    vbsLines = generateVbsLines(batPath);
    vbsContent = vbsLines.join('\r\n');
  });

  it('should create WScript.Shell object', () => {
    expect(vbsContent).toContain('CreateObject("WScript.Shell")');
  });

  it('should use WshShell.Run to launch bat file', () => {
    expect(vbsContent).toContain('WshShell.Run');
  });

  it('should triple-quote the bat path for proper escaping', () => {
    // VBScript requires triple quotes: """path""" to pass a quoted path
    expect(vbsContent).toContain(`"""${batPath}"""`);
  });

  it('should use 0 (hidden window) flag', () => {
    // WshShell.Run path, 0, False — 0 = hidden window
    expect(vbsContent).toContain(', 0, False');
  });

  it('should use False (no wait) to avoid blocking', () => {
    expect(vbsContent).toContain('False');
  });

  it('should be exactly 2 lines', () => {
    expect(vbsLines).toHaveLength(2);
  });
});

// =========================================================================
// Test: upgrade() platform branching
// =========================================================================
describe('upgrade() — platform branching logic', () => {
  it('should branch to upgradeWindows on win32', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain("platform() === 'win32'");
    expect(cliSource).toContain('upgradeWindows(latest)');
  });

  it('should use execSync npm install -g on non-Windows (Unix path)', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain('execSync(`npm install -g ${pkg.name}@latest`');
  });

  it('should use exact version (not @latest) in Windows pkgSpec', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    // upgradeWindows must use latestVersion parameter, not hardcoded @latest
    expect(cliSource).toContain('`${pkg.name}@${latestVersion}`');
  });

  it('should call process.exit(0) in upgradeWindows after spawning bat', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    // detached: true is required so the vbs/bat child survives parent process.exit(0)
    expect(cliSource).toContain("detached: true");
    expect(cliSource).toContain(".unref()");
    expect(cliSource).toContain("process.exit(0)");
  });

  it('should spawn wscript.exe to launch bat via VBScript wrapper', () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    expect(cliSource).toContain("windowsHide: true");
    expect(cliSource).toContain("spawn('wscript.exe'");
  });
});

// =========================================================================
// Test: cli.js upgradeWindows — PM2 handling logic
// =========================================================================
describe('cli.js upgradeWindows — PM2 handling', () => {
  let cliSource;
  let upgradeWindowsFn;

  beforeEach(() => {
    cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    upgradeWindowsFn = cliSource.slice(cliSource.indexOf('function upgradeWindows'));
  });

  it('should detect PM2 via pm2 jlist command', () => {
    expect(upgradeWindowsFn).toContain("pm2 jlist");
  });

  it('should parse pm2 jlist output as JSON', () => {
    expect(upgradeWindowsFn).toContain("JSON.parse(pm2List)");
  });

  it('should check for yeaft-agent in PM2 app list', () => {
    expect(upgradeWindowsFn).toContain("app.name === 'yeaft-agent'");
  });

  it('should delete PM2 app before process exit (prevent auto-restart race)', () => {
    // pm2 delete must happen BEFORE process.exit(0)
    const deleteIdx = upgradeWindowsFn.indexOf("pm2 delete yeaft-agent");
    const exitIdx = upgradeWindowsFn.indexOf("process.exit(0)");
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(exitIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeLessThan(exitIdx);
  });

  it('should use ecosystem.config.cjs path for PM2 re-registration in bat', () => {
    expect(upgradeWindowsFn).toContain("ecosystem.config.cjs");
  });

  it('should gracefully handle pm2 not being installed', () => {
    // The try/catch around pm2 jlist ensures non-PM2 environments work fine
    expect(upgradeWindowsFn).toContain("catch");
  });
});

// =========================================================================
// Test: cli.js upgradeWindows — VBScript wrapper
// =========================================================================
describe('cli.js upgradeWindows — VBScript wrapper', () => {
  let cliSource;
  let upgradeWindowsFn;

  beforeEach(() => {
    cliSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/cli.js'),
      'utf-8'
    );
    upgradeWindowsFn = cliSource.slice(cliSource.indexOf('function upgradeWindows'));
  });

  it('should generate VBScript with WScript.Shell', () => {
    expect(upgradeWindowsFn).toContain('CreateObject("WScript.Shell")');
  });

  it('should use WshShell.Run with hidden window (0) and no-wait (False)', () => {
    expect(upgradeWindowsFn).toContain(', 0, False');
  });

  it('should write vbs file with CRLF line endings', () => {
    expect(upgradeWindowsFn).toContain("vbsLines.join('\\r\\n')");
  });

  it('should spawn wscript.exe with vbsPath argument', () => {
    expect(upgradeWindowsFn).toContain("spawn('wscript.exe', [vbsPath]");
  });

  it('should clean up vbs file in bat script', () => {
    expect(upgradeWindowsFn).toContain('del /F /Q "${vbsPath}"');
  });
});

// =========================================================================
// Test: upgrade-worker-template.js retryOp integration
// =========================================================================
describe('upgrade-worker-template.js — retryOp integration', () => {
  it('should wrap rmSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.rmSync(full, { recursive: true, force: true }), 'rmdir '");
  });

  it('should wrap unlinkSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.unlinkSync(full), 'unlink '");
  });

  it('should wrap writeFileSync with retryOp', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("retryOp(() => fs.writeFileSync(dest, f.data), 'write '");
  });

  it('should have retryOp handle EBUSY, EPERM, and EACCES', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain("err.code === 'EBUSY'");
    expect(src).toContain("err.code === 'EPERM'");
    expect(src).toContain("err.code === 'EACCES'");
  });

  it('should use exponential backoff with max 10s delay', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain('Math.min(1000 * Math.pow(2, i), 10000)');
  });

  it('should default to maxRetries = 5', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade-worker-template.js'),
      'utf-8'
    );
    expect(src).toContain('maxRetries = 5');
  });
});

// =========================================================================
// Test: retryOp exponential backoff delay values
// =========================================================================
describe('retryOp — exponential backoff delay calculation', () => {
  it('should calculate correct delay sequence (1s, 2s, 4s, 8s, 10s capped)', () => {
    const delays = [];
    for (let i = 0; i < 5; i++) {
      delays.push(Math.min(1000 * Math.pow(2, i), 10000));
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000]);
  });

  it('should cap at 10000ms for higher retry indices', () => {
    const delay6 = Math.min(1000 * Math.pow(2, 5), 10000);
    const delay7 = Math.min(1000 * Math.pow(2, 6), 10000);
    expect(delay6).toBe(10000);
    expect(delay7).toBe(10000);
  });
});

// =========================================================================
// Test: Remote upgrade (upgrade.js) — PM2 race condition fix
// =========================================================================
describe('remote upgrade (upgrade.js) — PM2 race condition fix', () => {
  let upgradeSource;

  beforeEach(() => {
    upgradeSource = fs.readFileSync(
      path.join(process.cwd(), 'agent/connection/upgrade.js'),
      'utf-8'
    );
  });

  it('should delete PM2 app before process exit to prevent auto-restart', () => {
    // The fix: pm2 delete must happen BEFORE cleanupAndExit, not in the bat script
    const deleteIndex = upgradeSource.indexOf("pm2Path, ['delete'");
    const exitIndex = upgradeSource.indexOf('cleanupAndExit(0)');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(exitIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeLessThan(exitIndex);
  });

  it('should use execFileSync for pm2 delete (synchronous before exit)', () => {
    expect(upgradeSource).toContain("execFileSync(pm2Path, ['delete'");
  });

  it('should not have pm2 stop in the bat script (replaced by pre-exit pm2 delete)', () => {
    expect(upgradeSource).not.toContain("pm2 stop yeaft-agent");
  });

  it('should use findstr instead of find in bat script', () => {
    expect(upgradeSource).toContain('findstr /C:');
    expect(upgradeSource).not.toContain("| find /I");
  });

  it('should re-register PM2 via ecosystem config after upgrade', () => {
    expect(upgradeSource).toContain('pm2Win}" start');
    expect(upgradeSource).toContain('ecosystem.config.cjs');
  });

  it('should save PM2 process list after re-registering', () => {
    expect(upgradeSource).toContain('pm2Win}" save');
  });

  // --- PR #244: VBScript wrapper in upgrade.js ---
  it('should use VBScript wrapper (wscript.exe) instead of cmd.exe', () => {
    expect(upgradeSource).toContain("spawn('wscript.exe'");
    expect(upgradeSource).not.toContain("spawn('cmd.exe'");
  });

  it('should generate VBScript with WshShell.Run for bat detachment', () => {
    expect(upgradeSource).toContain('WshShell.Run');
    expect(upgradeSource).toContain('CreateObject("WScript.Shell")');
  });

  it('should clean up vbs file in bat script', () => {
    expect(upgradeSource).toContain('del /F /Q "${vbsPath}"');
  });

  // --- PR #244: Diagnostic timestamps ---
  it('should include diagnostic timestamps in bat script', () => {
    expect(upgradeSource).toContain('at %time%');
  });

  it('should log PM2 managed status in bat script', () => {
    expect(upgradeSource).toContain('PM2 managed:');
  });

  it('should wait extra time for file locks after PID exit', () => {
    expect(upgradeSource).toContain('waiting for file locks');
    expect(upgradeSource).toContain('ping -n 5');
  });
});
