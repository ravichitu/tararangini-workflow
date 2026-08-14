!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${IfNot} ${Silent}
      MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
        "Do you also want to permanently remove Tarangini company data and preferences?$\r$\n$\r$\nYES removes the database, settings, offline cache, certificates and backups stored in the Tarangini application-data folder.$\r$\n$\r$\nNO keeps all data for reinstalling or upgrading later.$\r$\n$\r$\nKeep data unless you already have a verified backup." \
        IDYES tarangini_delete_data IDNO tarangini_keep_data
      Abort

      tarangini_delete_data:
        RMDir /r "$APPDATA\${APP_FILENAME}"
        !ifdef APP_PRODUCT_FILENAME
          RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
        !endif
        !ifdef APP_PACKAGE_NAME
          RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
        !endif
        Goto tarangini_uninstall_choice_done

      tarangini_keep_data:
        DetailPrint "Tarangini company data and preferences were preserved."

      tarangini_uninstall_choice_done:
    ${EndIf}
  ${EndIf}
!macroend
