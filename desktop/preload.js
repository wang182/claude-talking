const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  processAudio: (wavArrayBuffer) => ipcRenderer.invoke('process-audio', wavArrayBuffer),
  processAudioWithImage: (wavArrayBuffer, imageBase64) =>
    ipcRenderer.invoke('process-audio-with-image', wavArrayBuffer, imageBase64),
  checkStatus: () => ipcRenderer.invoke('check-status'),
});
