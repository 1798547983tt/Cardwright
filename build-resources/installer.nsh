; Per-user installation. Keep profiles and prior installers for supervised rollback.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ReadEnvStr $0 "CARDWRIGHT_DATA_DIR"
  ${If} $0 == ""
    StrCpy $0 "$APPDATA\Cardwright"
  ${EndIf}
  CreateDirectory "$0\updates"
  CopyFiles /SILENT "$EXEPATH" "$0\updates\Cardwright-${VERSION}.exe"
  WriteINIStr "$INSTDIR\cardwright-install.ini" "Cardwright" "installed" "1"
  WriteINIStr "$INSTDIR\cardwright-install.ini" "Cardwright" "version" "${VERSION}"
!macroend
