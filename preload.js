// ============================================================
// FRIDAY AI – Preload Script (Context Bridge)
// Secure IPC between renderer and main process
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('friday', {
    // Window controls
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    toggleAlwaysOnTop: () => ipcRenderer.invoke('window-toggle-always-on-top'),
    getAlwaysOnTop: () => ipcRenderer.invoke('get-always-on-top'),
    getPort: () => ipcRenderer.invoke('get-port'),

    // Listen for events from main process
    onNotification: (callback) => {
        ipcRenderer.on('friday-notification', (_, data) => callback(data));
    },
    onProactive: (callback) => {
        ipcRenderer.on('friday-proactive', (_, data) => callback(data));
    },
    onNewSession: (callback) => {
        ipcRenderer.on('new-session', () => callback());
    },
});
