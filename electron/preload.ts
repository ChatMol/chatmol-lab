import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  isPackaged: process.env.CHATMOL_IS_PACKAGED === "true",
  openExternal: (url: string) => {
    // Only allow HTTPS URLs
    if (typeof url === "string" && url.startsWith("https://")) {
      ipcRenderer.invoke("open-external", url);
    }
  },
  chooseDirectory: (options?: { defaultPath?: string; title?: string }): Promise<string | null> =>
    ipcRenderer.invoke("choose-directory", options),
});
