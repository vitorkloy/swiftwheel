; Injected by electron-builder (see package.json build.nsis.include).
; Ensures the app fully exits — including child processes (e.g. PowerShell mouse hook) —
; so files under $INSTDIR are not locked during uninstall.
;
; VOR → SwiftWheel: o GUID NSIS e o appId ficam iguais, então o Windows trata isto como
; o mesmo produto. O productName (e o .exe) mudam; estes macros matam o processo antigo,
; apagam o VOR.exe residual no mesmo $INSTDIR, e limpam atalhos / Run da instalação VOR.

!macro customInit
  ; /T kills the process tree (important for spawned helpers).
  ExecWait 'cmd.exe /c taskkill /F /T /IM "VOR.exe" /IM "SwiftWheel.exe" /IM "vor-capture.exe"' $0
  Sleep 1000
!macroend

!macro customUnInit
  ; /T kills the process tree (important for spawned helpers).
  ExecWait 'cmd.exe /c taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /IM "VOR.exe" /IM "vor-capture.exe"' $0
  Sleep 2000
!macroend

!macro customInstall
  ; Mesmo $INSTDIR de uma instalação VOR (--updated / mesmo GUID): o binário antigo não é
  ; substituído pelo novo nome, ficaria um VOR.exe ao lado do SwiftWheel.exe.
  Delete "$INSTDIR\VOR.exe"

  Delete "$DESKTOP\VOR.lnk"
  Delete "$SMPROGRAMS\VOR.lnk"
  Delete "$SMSTARTUP\VOR.lnk"
  Delete "$PROFILE\Desktop\VOR.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\VOR.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\VOR.lnk"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "VOR"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "vor"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Rovyl"
!macroend
