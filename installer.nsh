; Custom NSIS script for ProSystem Print Agent
; This script handles closing the running application before installation

!macro customHeader
  ; Define the process name to kill
  !define PROCESS_NAME "ProSystem Print Agent.exe"
!macroend

!macro customInit
  ; Kill the process if it's running before installation starts
  nsExec::ExecToLog 'taskkill /F /IM "${PROCESS_NAME}" /T'
  Pop $0

  ; Also try to gracefully shutdown via API endpoint
  ; This will work for newer versions with /shutdown endpoint
  nsExec::ExecToLog 'curl -X POST http://127.0.0.1:21321/shutdown -m 2'
  Pop $0

  ; Wait 2 seconds for graceful shutdown
  Sleep 2000

  ; Force kill again to ensure it's closed
  nsExec::ExecToLog 'taskkill /F /IM "${PROCESS_NAME}" /T'
  Pop $0

  ; Wait another second
  Sleep 1000
!macroend

!macro customInstall
  ; Nothing special needed here
!macroend

!macro customUnInit
  ; Kill the process before uninstallation
  nsExec::ExecToLog 'taskkill /F /IM "${PROCESS_NAME}" /T'
  Pop $0
  Sleep 1000
!macroend
