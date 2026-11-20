!define SHARESUB_PROTOCOL_KEY "Software\Classes\sharesub"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}" "" "URL:ShareSub"
  WriteRegStr SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}\DefaultIcon" "" '"$appExe",0'
  WriteRegStr SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}\shell\open\command" "" '"$appExe" -- "%1"'
!macroend

!macro customUnInstall
  ReadRegStr $R0 SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}\shell\open\command" ""
  ${If} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
    DeleteRegKey SHELL_CONTEXT "${SHARESUB_PROTOCOL_KEY}"
  ${EndIf}
!macroend
