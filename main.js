const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const AutoLaunch = require('auto-launch');
const path = require('path');
const { startApi, broadcastPrinterStatus, formatPrinterList } = require('./printer-api');

let autoUpdater;

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
    console.log('Old instance may be stuck. This instance will quit.');
    // Could not reach the old instance - just quit
    app.quit();
  });

  req.on('timeout', () => {
    console.log('Timeout reaching old instance. This instance will quit.');
    req.destroy();
    app.quit();
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
    console.log('Update will be installed on next app restart');

    // Update tray menu to show update is ready
    if (tray) {
      const currentMenu = tray.getContextMenu();
      const items = currentMenu ? currentMenu.items : [];

      const newMenu = Menu.buildFromTemplate([
        ...items.slice(0, -2), // Remove download progress item
        {
          label: `Update v${info.version} ready - Restart now`,
          click: () => {
            console.log('User clicked restart - installing update...');
            autoUpdater.quitAndInstall(false, true); // Don't force close, restart immediately
          }
        },
        { type: 'separator' },
        { label: 'Restart', click: () => { app.relaunch(); app.quit(); } }
      ]);
      tray.setContextMenu(newMenu);
      tray.setToolTip(`Update v${info.version} ready - will install on restart`);
    }
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

    // Check for updates every 6 hours
    setInterval(() => {
      console.log('Periodic update check...');
      autoUpdater.checkForUpdates();
    }, 6 * 60 * 60 * 1000); // 6 hours
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