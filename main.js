// ============================================================
// FRIDAY AI – Electron Main Process
// Desktop shell: window, tray, IPC, boots the backend
// ============================================================

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, globalShortcut } = require('electron');
const path = require('path');
const db = require('./src/memory/database');
const FridayServer = require('./src/server/server');
const Scheduler = require('./src/scheduler/scheduler');

let mainWindow = null;
let tray = null;
let server = null;
let scheduler = null;
let isQuitting = false;

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

    // Widget-style window: right-aligned, tall, slim
    const winWidth = 440;
    const winHeight = Math.min(screenHeight - 80, 900);
    const winX = screenWidth - winWidth - 16;
    const winY = 40;

    mainWindow = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: winX,
        y: winY,
        minWidth: 380,
        minHeight: 500,
        frame: false,
        transparent: false,
        resizable: true,
        skipTaskbar: false,
        alwaysOnTop: false,
        backgroundColor: '#0a0a0f',
        icon: getAppIcon(),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            devTools: process.argv.includes('--dev'),
        },
        show: false,
        title: 'FRIDAY AI',
    });

    mainWindow.loadURL(`http://127.0.0.1:${server.port}`);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    // Register global shortcut: Ctrl+Shift+F to toggle window
    globalShortcut.register('CommandOrControl+Shift+F', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function getAppIcon() {
    // Create a simple programmatic icon (purple circle with F)
    try {
        const iconPath = path.join(__dirname, 'assets', 'icon.png');
        const fs = require('fs');
        if (fs.existsSync(iconPath)) {
            return nativeImage.createFromPath(iconPath);
        }
    } catch (e) { }
    return null;
}

function createTray() {
    const icon = getAppIcon() || nativeImage.createEmpty();

    // If icon is empty, create a 16x16 placeholder
    let trayIcon = icon;
    if (icon.isEmpty()) {
        trayIcon = nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 128), { width: 16, height: 16 });
    }

    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
    tray.setToolTip('FRIDAY AI – Your Personal Assistant');

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open FRIDAY',
            click: () => {
                mainWindow.show();
                mainWindow.focus();
            },
        },
        { type: 'separator' },
        {
            label: 'New Conversation',
            click: () => {
                server.getAgent().newSession();
                mainWindow.show();
                mainWindow.webContents.send('new-session');
            },
        },
        { type: 'separator' },
        {
            label: 'Quit FRIDAY',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', () => {
        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

async function bootBackend() {
    // Initialize database
    const dataDir = path.join(app.getPath('userData'), 'data');
    db.init(dataDir);

    // Start server
    server = new FridayServer();
    server.init();
    await server.start();

    console.log('[FRIDAY] Backend ready');
}

function bootScheduler() {
    scheduler = new Scheduler(server.getAgent(), mainWindow);
    scheduler.start();
}

// IPC handlers for renderer process
function setupIPC() {
    ipcMain.handle('get-port', () => server.port);

    ipcMain.handle('window-minimize', () => {
        mainWindow.minimize();
    });

    ipcMain.handle('window-maximize', () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });

    ipcMain.handle('window-close', () => {
        mainWindow.hide();
    });

    ipcMain.handle('window-toggle-always-on-top', () => {
        const current = mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(!current);
        return !current;
    });

    ipcMain.handle('get-always-on-top', () => {
        return mainWindow.isAlwaysOnTop();
    });
}

// ---- APP LIFECYCLE ----

app.whenReady().then(async () => {
    try {
        await bootBackend();
        setupIPC();
        createWindow();
        createTray();
        bootScheduler();
        console.log('[FRIDAY] All systems online ✨');
    } catch (err) {
        console.error('[FRIDAY] Boot failed:', err);
        app.quit();
    }
});

app.on('window-all-closed', (e) => {
    // Don't quit on window close — stay in tray
    if (process.platform !== 'darwin') {
        e?.preventDefault?.();
    }
});

app.on('activate', () => {
    if (mainWindow) {
        mainWindow.show();
    }
});

app.on('before-quit', () => {
    isQuitting = true;
    if (scheduler) scheduler.stop();
    if (server) server.stop();
    if (db) db.close();
    globalShortcut.unregisterAll();
});
