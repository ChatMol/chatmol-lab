; Custom NSIS hook (auto-included by electron-builder).
; Run the bundled Python + WeMol CLI runtime setup during installation, so it
; is ready BEFORE the app is first opened. Non-fatal: if it fails or is skipped,
; the app installs the runtime on first launch (with a progress window).
!macro customInstall
  ; Install the bundled native Python + WeMol CLI runtime before first open.
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --setup'
  ; Best-effort: enable WSL2 (the Linux runtime for bioconda tooling). This needs
  ; admin rights + a reboot, so it's fire-and-forget here; the app finishes
  ; provisioning the Linux conda runtime on first launch once WSL is available.
  Exec 'cmd.exe /c wsl --install'
!macroend
