const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const AutoLaunch = require('auto-launch');
const path = require('path');
const { startApi, broadcastPrinterStatus, formatPrinterList } = require('./printer-api');
const { exec } = require('child_process');

let autoUpdater;

// Force kill old instance if graceful shutdown fails (for old versions without /shutdown endpoint)
function forceKillOldInstance() {
  if (process.platform !== 'win32') {
    console.log('Force kill only supported on Windows. Quitting.');
    app.quit();
    return;
  }

  console.log('Finding and terminating processes on ports 21321 and 21322...');

  // Kill process on port 21321 (HTTP API)
  exec('netstat -ano | findstr ":21321 "', (_error, stdout) => {
    if (stdout) {
      const lines = stdout.trim().split('\n');
      const pids = new Set();

      lines.forEach(line => {
        const portPattern = /:21321\s/;
        if (portPattern.test(line)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(pid) && pid !== '0') {
            pids.add(pid);
          }
        }
      });

      if (pids.size > 0) {
        console.log(`Killing processes: ${Array.from(pids).join(', ')}`);
        pids.forEach(pid => {
          exec(`taskkill /F /PID ${pid}`, (err) => {
            if (err) {
              console.error(`Failed to kill PID ${pid}:`, err.message);
            } else {
              console.log(`Successfully killed PID ${pid}`);
            }
          });
        });

        // Wait for processes to be killed, then relaunch
        setTimeout(() => {
          console.log('Old instance terminated. Relaunching new instance...');
          app.relaunch();
          app.quit();
        }, 2000);
      } else {
        console.log('No processes found on port 21321. Quitting.');
        app.quit();
      }
    } else {
      console.log('Could not find processes. Quitting.');
      app.quit();
    }
  });
}

// **CRITICAL**: This prevents multiple instances of the agent from running.
// If we can't get the lock, it means another instance is running.
// We'll attempt to signal the old instance to shut down gracefully.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log('Another instance is already running. Attempting graceful handoff...');

  // Try to signal the old instance to shut down
  const http = require('http');
  const options = {
    hostname: '127.0.0.1',
    port: 21321,
    path: '/shutdown',
    method: 'POST',
    timeout: 3000
  };

  const req = http.request(options, () => {
    console.log('Shutdown signal sent to old instance. This instance will now start.');
    // Wait for old instance to shut down, then restart this one
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 3000);
  });

  req.on('error', (err) => {
    console.log('Could not reach old instance:', err.message);
    console.log('Old instance may not have /shutdown endpoint (older version).');
    console.log('Attempting to force kill old instance via port recovery...');

    // Force kill the old instance by terminating processes on our ports
    forceKillOldInstance();
  });

  req.on('timeout', () => {
    console.log('Timeout reaching old instance.');
    console.log('Attempting to force kill old instance via port recovery...');
    req.destroy();

    // Force kill the old instance by terminating processes on our ports
    forceKillOldInstance();
  });

  req.end();
} else {
  // We got the lock - handle second-instance attempts
  app.on('second-instance', () => {
    console.log('Another instance tried to start. Ignoring (this instance is primary).');
  });
}

let shellWindow;
let tray = null;
let statusWindow = null;
let appStartTime = Date.now(); // Track uptime

// Keep global reference to prevent GC
global.trayIcon = null;
let trayIconPath = null;
let trayCreationAttempts = 0;

// Function to set up auto-updater event handlers
const setupAutoUpdater = () => {
  autoUpdater = require('electron-updater').autoUpdater;

  // Configure auto-updater for fully automatic updates
  autoUpdater.autoDownload = true; // Automatically download updates in background
  autoUpdater.autoInstallOnAppQuit = true; // Install when app quits

  // Auto-updater event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    console.log('Downloading update automatically in background...');

    // Update tray menu to show download is happening
    if (tray) {
      const currentMenu = tray.getContextMenu();
      const items = currentMenu ? currentMenu.items : [];

      const newMenu = Menu.buildFromTemplate([
        ...items.slice(0, -1), // Keep existing items
        { label: `Downloading v${info.version}...`, enabled: false },
        { type: 'separator' },
        ...items.slice(-1) // Keep Restart option
      ]);
      tray.setContextMenu(newMenu);
      tray.setToolTip(`Downloading update v${info.version}...`);
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('No updates available');
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = progressObj.percent.toFixed(0);
    console.log(`Download progress: ${percent}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    console.log('Installing update and restarting in 5 seconds...');

    // Show brief notification in tray
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(`Installing update v${info.version}...`);
    }

    // Wait 5 seconds to allow any active print jobs to complete
    // then automatically restart and install
    setTimeout(() => {
      console.log('Auto-restarting to install update...');
      autoUpdater.quitAndInstall(false, true); // Don't force close, restart immediately
    }, 5000);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err);
    // Reset tray tooltip on error
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip('ProSystem Print Agent');
    }
  });
};

const createStatusWindow = () => {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.show();
    statusWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, 'build', 'web-app-manifest-512x512.ico');

  statusWindow = new BrowserWindow({
    width: 400,
    height: 380,
    resizable: false,
    minimizable: false,
    maximizable: false,
    frame: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  statusWindow.loadFile(path.join(__dirname, 'status-window.html'));
  statusWindow.setMenuBarVisibility(false);

  statusWindow.on('closed', () => {
    statusWindow = null;
  });
};

const updateTrayMenu = async (trayInstance, webContents) => {
  try {
    const rawPrinters = await webContents.getPrintersAsync();
    const printers = formatPrinterList(rawPrinters);
    const defaultPrinter = printers.find(p => p.isDefault);

    const statusItem = printers.length > 0
      ? { label: `Default: ${defaultPrinter?.name || '(none)'}`, enabled: false }
      : { label: 'No Printers Found', enabled: false };

    const contextMenu = Menu.buildFromTemplate([
      statusItem,
      { type: 'separator' },
      { label: 'Restart', click: () => { app.relaunch(); app.quit(); } },
      // { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);

    trayInstance.setToolTip(printers.length > 0 ? 'Print Agent is running' : 'No printers detected');
    trayInstance.setContextMenu(contextMenu);

    broadcastPrinterStatus(printers);
  } catch (e) {
    const errorMenu = Menu.buildFromTemplate([
      { label: 'Error detecting printers', enabled: false },
      { label: 'Restart', click: () => { app.relaunch(); app.quit(); } }
    ]);
    trayInstance.setToolTip('Print Agent error');
    trayInstance.setContextMenu(errorMenu);
    broadcastPrinterStatus([]);
  }
};

app.whenReady().then(() => {
  // Initialize auto-updater
  setupAutoUpdater();

  const appIconPath = path.join(__dirname, 'build', 'web-app-manifest-512x512.ico');

  shellWindow = new BrowserWindow({
    show: false,
    icon: appIconPath,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });
  shellWindow.loadURL('data:text/html,<html></html>'); // A lightweight, invisible window to host the print logic

  // Start API with error recovery
  startApi(shellWindow.webContents);

  // Listen for API startup failures
  shellWindow.webContents.on('ipc-message', (_event, channel, data) => {
    if (channel === 'api-startup-failed') {
      console.error('API startup failed:', data.error);
      console.log('Attempting app restart to recover...');

      // Restart the entire app after a delay
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 2000);
    }
  });

  // Create tray icon with proper handling to ensure it always displays
  // Store path globally to prevent issues
  trayIconPath = path.join(__dirname, 'build', 'web-app-manifest-512x512.ico');

  // Function to create or recreate the tray icon
  const createTray = () => {
    try {
      // Destroy existing tray if it exists
      if (tray && !tray.isDestroyed()) {
        tray.destroy();
      }

      let icon = nativeImage.createFromPath(trayIconPath);

      // Ensure icon is valid and not empty
      if (icon.isEmpty()) {
        console.error('Failed to load tray icon from:', trayIconPath);
        // Try fallback to other icon files
        const fallbackPaths = [
          path.join(__dirname, 'build', 'icon.ico'),
          path.join(__dirname, 'build', 'favicon-32x32.png')
        ];

        for (const fallbackPath of fallbackPaths) {
          icon = nativeImage.createFromPath(fallbackPath);
          if (!icon.isEmpty()) {
            console.log('Using fallback icon:', fallbackPath);
            break;
          }
        }
      }

      // Create the tray
      tray = new Tray(icon);

      // Store globally to prevent garbage collection
      global.trayIcon = tray;

      tray.setToolTip('ProSystem Print Agent');

      // Left-click on tray icon shows status window
      tray.on('click', () => {
        createStatusWindow();
      });

      // Right-click shows context menu
      updateTrayMenu(tray, shellWindow.webContents);

      console.log('Tray created successfully');
      trayCreationAttempts = 0;
    } catch (error) {
      console.error('Error creating tray:', error);
      trayCreationAttempts++;

      // Retry after a delay if failed
      if (trayCreationAttempts < 5) {
        setTimeout(createTray, 2000);
      }
    }
  };

  // Initial tray creation
  createTray();

  // Monitor for Windows Explorer restarts (common cause of tray icon disappearing)
  // Check if tray is destroyed periodically and recreate if needed
  setInterval(() => {
    if (!tray || tray.isDestroyed()) {
      console.log('Tray icon was destroyed, recreating...');
      createTray();
    }
  }, 5000); // Check every 5 seconds

  // Handle display events that might cause tray icon to disappear
  const { screen } = require('electron');

  screen.on('display-added', () => {
    console.log('Display added, checking tray...');
    if (!tray || tray.isDestroyed()) {
      createTray();
    }
  });

  screen.on('display-removed', () => {
    console.log('Display removed, checking tray...');
    if (!tray || tray.isDestroyed()) {
      setTimeout(createTray, 1000);
    }
  });

  screen.on('display-metrics-changed', () => {
    // Recreate tray on significant display changes
    if (!tray || tray.isDestroyed()) {
      createTray();
    }
  });

  // Update tray menu periodically
  setInterval(() => {
    if (tray && !tray.isDestroyed() && shellWindow && !shellWindow.isDestroyed()) {
      updateTrayMenu(tray, shellWindow.webContents);
    }
  }, 10000); // Check for printer changes every 10s

  // Prevent tray from being destroyed on app quit
  app.on('before-quit', () => {
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
    }
  });

  // Set up IPC handlers for status window
  ipcMain.on('request-status', async (event) => {
    try {
      // Check if shellWindow exists and is not destroyed
      if (!shellWindow || shellWindow.isDestroyed()) {
        event.reply('status-update', {
          apiStatus: 'offline',
          printers: [],
          uptime: Date.now() - appStartTime,
          error: 'Shell window not available'
        });
        return;
      }

      const rawPrinters = await shellWindow.webContents.getPrintersAsync();
      const printers = formatPrinterList(rawPrinters);
      const uptime = Date.now() - appStartTime;

      event.reply('status-update', {
        apiStatus: 'online',
        printers: printers,
        uptime: uptime
      });
    } catch (error) {
      event.reply('status-update', {
        apiStatus: 'offline',
        printers: [],
        uptime: Date.now() - appStartTime,
        error: error.message
      });
    }
  });

  ipcMain.on('close-status-window', () => {
    if (statusWindow && !statusWindow.isDestroyed()) {
      statusWindow.close();
    }
  });

  ipcMain.on('restart-app', () => {
    app.relaunch();
    app.quit();
  });

  if (app.isPackaged) {
    const autoLauncher = new AutoLaunch({
      name: 'ProSystem Print Agent',
      path: app.getPath('exe'),
    });
    autoLauncher.isEnabled().then((isEnabled) => {
      if (!isEnabled) autoLauncher.enable();
    });

    // Check for updates on startup (only in production)
    console.log('Checking for updates...');
    autoUpdater.checkForUpdates();

    // Check for updates every 30 minutes for faster rollout
    setInterval(() => {
      console.log('Periodic update check...');
      autoUpdater.checkForUpdates();
    }, 30 * 60 * 1000); // 30 minutes
  }

});

// Global error handlers to prevent app crashes
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Log the error but don't crash the app
  if (error.stack) {
    console.error('Stack trace:', error.stack);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Log the error but don't crash the app
});

// Handle renderer process crashes gracefully
app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('Renderer process gone:', details);
  // Optionally restart the shell window if it crashes
  if (shellWindow && shellWindow.isDestroyed()) {
    console.log('Attempting to recreate shell window...');
    setTimeout(() => {
      shellWindow = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      shellWindow.loadURL('data:text/html,<h1>Print Agent</h1>');
    }, 1000);
  }
});

// This ensures the app doesn't close when the invisible window is closed.
app.on('window-all-closed', (e) => {
  e.preventDefault();
});