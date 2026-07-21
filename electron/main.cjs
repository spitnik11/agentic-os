/**
 * Electron main process.
 *
 * Agentic OS is a Next.js application that needs a real Node runtime: it reads
 * the vault from disk and uses `node:sqlite`. So the desktop build does not
 * reimplement anything — it starts the same production server the web mode
 * uses, on a loopback-only port, and puts a native window in front of it.
 *
 * That choice is what keeps the security guarantees intact: the write boundary,
 * the fail-closed privacy policy, and the provenance rules all live in the
 * server and are untouched by this file.
 *
 * CommonJS on purpose. package.json declares "type": "module", so a `.js` file
 * here would be loaded as ESM; `.cjs` keeps the entry point unambiguous.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = !app.isPackaged;

/** node:sqlite landed in Node 22.5. Below that the server cannot open its database. */
const MIN_NODE = { major: 22, minor: 5 };

let serverProcess = null;
let mainWindow = null;
let serverPort = null;
let shuttingDown = false;

/* -------------------------------------------------------------------------- */
/* Runtime selection                                                          */
/* -------------------------------------------------------------------------- */

function parseNodeVersion(version) {
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return { major: major ?? 0, minor: minor ?? 0 };
}

function isNodeNewEnough(version) {
  const v = parseNodeVersion(version);
  if (v.major > MIN_NODE.major) return true;
  return v.major === MIN_NODE.major && v.minor >= MIN_NODE.minor;
}

/**
 * Decide which Node runs the server.
 *
 * Preferred: Electron's own bundled Node, via ELECTRON_RUN_AS_NODE. That leaves
 * the app with no dependency on a system Node install. It only works if the
 * bundled version is new enough for node:sqlite, which is why this is checked
 * rather than assumed.
 *
 * Fallback: a system `node` on PATH.
 */
function chooseRuntime() {
  if (isNodeNewEnough(process.versions.node)) {
    return {
      command: process.execPath,
      useElectronAsNode: true,
      description: `Electron bundled Node ${process.versions.node}`,
    };
  }

  return {
    command: 'node',
    useElectronAsNode: false,
    description: `system Node (Electron bundles ${process.versions.node}, which predates node:sqlite)`,
  };
}

/* -------------------------------------------------------------------------- */
/* Port selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Check a port by trying to connect to it.
 *
 * Deliberately not a bind test: on Windows, binding to 127.0.0.1 succeeds even
 * while another socket holds the same port on the wildcard address, which is
 * exactly how a Node server listens. A bind test therefore reports "free" for a
 * port already in use, and we would start a second server on top of the first.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (free) => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

async function findFreePort(start = 3000, end = 3040) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port between ${start} and ${end}.`);
}

/* -------------------------------------------------------------------------- */
/* Configuration checks                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read VAULT_ROOT out of .env.local so a misconfiguration produces a readable
 * message instead of a window showing a server error.
 */
function readVaultRoot() {
  const envFile = path.join(APP_ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return { ok: false, reason: 'missing-env' };

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*VAULT_ROOT\s*=\s*(.+?)\s*$/.exec(line);
    if (match) {
      const value = match[1].replace(/^["']|["']$/g, '').trim();
      if (value === '') return { ok: false, reason: 'empty-vault-root' };
      if (!fs.existsSync(value)) return { ok: false, reason: 'missing-vault', value };
      return { ok: true, value };
    }
  }
  return { ok: false, reason: 'no-vault-root' };
}

function showConfigError(check) {
  const messages = {
    'missing-env': {
      title: 'Configuration file missing',
      detail:
        'Agentic OS could not find its .env.local file.\n\n' +
        `Copy .env.example to .env.local in:\n${APP_ROOT}\n\n` +
        'then set VAULT_ROOT to your Obsidian vault folder.',
    },
    'no-vault-root': {
      title: 'Vault location not set',
      detail: `VAULT_ROOT is not set in:\n${path.join(APP_ROOT, '.env.local')}\n\nSet it to your Obsidian vault folder and start again.`,
    },
    'empty-vault-root': {
      title: 'Vault location is empty',
      detail: `VAULT_ROOT has no value in:\n${path.join(APP_ROOT, '.env.local')}\n\nSet it to your Obsidian vault folder, for example:\nC:\\Users\\YourName\\Documents\\MyVault`,
    },
    'missing-vault': {
      title: 'Vault folder not found',
      detail: `VAULT_ROOT points at a folder that does not exist:\n\n${check.value}\n\nFix the path in .env.local and start again.`,
    },
  };

  const message = messages[check.reason] ?? {
    title: 'Configuration problem',
    detail: 'Agentic OS could not read its configuration.',
  };

  dialog.showErrorBox(message.title, message.detail);
}

/* -------------------------------------------------------------------------- */
/* Server lifecycle                                                           */
/* -------------------------------------------------------------------------- */

function waitForHealth(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() > deadline) return resolve(false);
      if (serverProcess === null || serverProcess.exitCode !== null) return resolve(false);

      const request = net.connect({ port, host: '127.0.0.1' }, () => {
        request.destroy();
        // The socket is open; confirm the app itself is answering.
        fetch(`http://127.0.0.1:${port}/api/health`)
          .then((res) => (res.ok ? res.json() : null))
          .then((body) => {
            if (body && body.status === 'ok') resolve(true);
            else setTimeout(attempt, 400);
          })
          .catch(() => setTimeout(attempt, 400));
      });
      request.once('error', () => {
        request.destroy();
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function startServer() {
  serverPort = await findFreePort();
  const runtime = chooseRuntime();

  const nextBin = path.join(APP_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!fs.existsSync(nextBin)) {
    throw new Error(`Next.js is not installed. Run "npm install" in ${APP_ROOT}.`);
  }

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(serverPort),
    // Loopback only. The desktop app never exposes the vault to the network.
    HOSTNAME: '127.0.0.1',
  };
  if (runtime.useElectronAsNode) env.ELECTRON_RUN_AS_NODE = '1';

  console.log(`[agentic-os] starting server on 127.0.0.1:${serverPort} using ${runtime.description}`);

  serverProcess = spawn(runtime.command, [nextBin, 'start', '-p', String(serverPort), '-H', '127.0.0.1'], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  serverProcess.on('exit', (code) => {
    console.log(`[agentic-os] server exited with code ${code}`);
    serverProcess = null;
    // An unexpected exit while the window is open means the app is dead; do not
    // leave an empty frame sitting there pretending otherwise.
    if (!shuttingDown && mainWindow !== null) {
      dialog.showErrorBox(
        'Agentic OS stopped',
        `The background server exited unexpectedly (code ${code}).\n\nRestart the application. If it keeps happening, run "npm run doctor" in:\n${APP_ROOT}`,
      );
      app.quit();
    }
  });

  const healthy = await waitForHealth(serverPort);
  if (!healthy) throw new Error('The server did not become healthy in time.');
}

/**
 * Stop the server and everything it spawned.
 *
 * On Windows a plain kill() on the parent orphans the real server: the process
 * chain runs through an intermediate that gets reparented. taskkill /T walks the
 * actual tree, which is the only reliable way to leave nothing behind.
 */
function stopServer() {
  if (serverProcess === null) return;
  shuttingDown = true;
  const pid = serverProcess.pid;
  serverProcess = null;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Nothing further to try; the process may already be gone.
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already exited.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

const boundsFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (typeof saved.width === 'number' && typeof saved.height === 'number') return saved;
  } catch {
    // First run, or the file was damaged; fall through to defaults.
  }
  return { width: 1440, height: 900 };
}

function saveBounds() {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getNormalBounds();
    fs.mkdirSync(path.dirname(boundsFile()), { recursive: true });
    fs.writeFileSync(
      boundsFile(),
      JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }),
    );
  } catch {
    // Losing window position is not worth interrupting a shutdown for.
  }
}

function createWindow() {
  const saved = loadBounds();

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Agentic OS',
    backgroundColor: '#0c0c0d',
    // Do not flash an empty white frame while the first paint happens.
    show: false,
    icon: path.join(APP_ROOT, 'assets', 'agentic-os.ico'),
    webPreferences: {
      // The window only ever loads our own loopback server, but there is no
      // reason for the renderer to hold Node privileges, so it does not.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (saved.maximized) mainWindow.maximize();

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Links to anywhere other than our own server open in the real browser
  // rather than navigating the app frame away from itself.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(`http://127.0.0.1:${serverPort}`),
        },
        {
          label: 'Open Vault Folder',
          click: () => {
            const check = readVaultRoot();
            if (check.ok) shell.openPath(check.value);
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Health Check',
          click: () => shell.openExternal(`http://127.0.0.1:${serverPort}/api/health`),
        },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Agentic OS',
              message: 'Agentic OS',
              detail:
                'A visual command center for an Obsidian vault.\n\n' +
                `Electron ${process.versions.electron}\n` +
                `Chromium ${process.versions.chrome}\n` +
                `Node ${process.versions.node}\n` +
                `Server port ${serverPort}\n\n` +
                'Built with Claude. Not affiliated with or endorsed by Anthropic.',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* -------------------------------------------------------------------------- */
/* Application lifecycle                                                      */
/* -------------------------------------------------------------------------- */

// One instance only. A second copy would run a second server against the same
// database and the same vault.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const check = readVaultRoot();
    if (!check.ok) {
      showConfigError(check);
      app.quit();
      return;
    }

    try {
      await startServer();
    } catch (error) {
      dialog.showErrorBox(
        'Agentic OS could not start',
        `${error instanceof Error ? error.message : String(error)}\n\n` +
          `Try running "npm run doctor" in:\n${APP_ROOT}`,
      );
      stopServer();
      app.quit();
      return;
    }

    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', stopServer);
  app.on('will-quit', stopServer);

  // Belt and braces: a crash or an external kill should still not leave the
  // server running with a lock on the database.
  process.on('exit', stopServer);
  process.on('SIGINT', () => { stopServer(); process.exit(0); });
  process.on('SIGTERM', () => { stopServer(); process.exit(0); });
}
