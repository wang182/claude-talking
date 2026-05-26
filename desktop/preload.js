const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  processAudio: (wavArrayBuffer) => ipcRenderer.invoke('process-audio', wavArrayBuffer),
  processAudioWithImage: (wavArrayBuffer, imageBase64) =>
    ipcRenderer.invoke('process-audio-with-image', wavArrayBuffer, imageBase64),
  processText: (text) => ipcRenderer.invoke('process-text', text),
  processTextWithImage: (text, imageBase64) => ipcRenderer.invoke('process-text-with-image', text, imageBase64),
  transcribeAudio: (wavArrayBuffer) => ipcRenderer.invoke('transcribe-audio', wavArrayBuffer),
  thinkText: (text) => ipcRenderer.invoke('think-text', text),
  synthesizeText: (text) => ipcRenderer.invoke('synthesize-text', text),
  checkStatus: () => ipcRenderer.invoke('check-status'),
  onWarmupReady: (callback) => ipcRenderer.on('warmup-ready', () => callback()),
  onSetupProgress: (callback) => ipcRenderer.on('setup-progress', (_event, info) => callback(info)),
  onSetupStart: (callback) => ipcRenderer.on('setup-start', () => callback()),
  onSetupDone: (callback) => ipcRenderer.on('setup-done', (_event, ok) => callback(ok)),
});
