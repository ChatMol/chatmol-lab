interface ElectronAPI {
  isElectron: boolean;
  isPackaged?: boolean;
  openExternal?: (url: string) => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
