const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  processAudio: (wavArrayBuffer) => ipcRenderer.invoke('process-audio', wavArrayBuffer),
  processAudioWithImage: (wavArrayBuffer, imageBase64) =>
    ipcRenderer.invoke('process-audio-with-image', wavArrayBuffer, imageBase64),
  processText: (text) => ipcRenderer.invoke('process-text', text),
  checkStatus: () => ipcRenderer.invoke('check-status'),
  onWarmupReady: (callback) => ipcRenderer.on('warmup-ready', () => callback()),
});
