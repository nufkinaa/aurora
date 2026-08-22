@echo off
rem Builds the Aurora TV release APK and publishes it to public\aurora-tv.apk
rem (the URL the app's self-update check points at).
setlocal

rem Every path here is absolute, derived from this script's own location, so it
rem does not matter what directory you launch it from.
set "ROOT=%~dp0"
set "ANDROID_DIR=%ROOT%android"
set "GRADLEW=%ANDROID_DIR%\gradlew.bat"
set "APK=%ANDROID_DIR%\app\build\outputs\apk\release\app-release.apk"
set "PUBLISH=%ROOT%..\public\aurora-tv.apk"

cd /d "%ANDROID_DIR%" || (
  echo Could not enter %ANDROID_DIR%
  exit /b 1
)

rem Gradle needs a JDK; point it at this machine's JDK when the shell has none.
if not defined JAVA_HOME set "JAVA_HOME=C:\elia\android-tools\jdk"
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo JAVA_HOME does not point at a JDK: %JAVA_HOME%
  echo Install a JDK or fix the path in this script.
  exit /b 1
)

rem Metro (the JS bundler) needs node; make sure it's reachable.
where node >nul 2>nul
if errorlevel 1 set "PATH=%PATH%;C:\Program Files\nodejs"
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found - install Node.js or fix the path in this script.
  exit /b 1
)

if not exist "%GRADLEW%" (
  echo Missing %GRADLEW%
  exit /b 1
)

echo Building release APK...
rem MUST be called by full path, not as a bare `gradlew.bat`. This machine has
rem NoDefaultCurrentDirectoryInExePath=1 set, which stops cmd searching the
rem current directory for an executable — so the bare name failed with
rem "'gradlew.bat' is not recognized" even while sitting right next to it.
call "%GRADLEW%" assembleRelease --console=plain --no-daemon
if errorlevel 1 (
  echo.
  echo BUILD FAILED
  exit /b 1
)

if not exist "%APK%" (
  echo.
  echo Gradle reported success but %APK% is missing.
  exit /b 1
)

rem The copy can fail with "cannot be performed on a file with a user-mapped
rem section open": the running server has served public\aurora-tv.apk and Windows
rem still has it memory-mapped. It clears in a moment, so retry rather than
rem throwing away a good build.
set "COPIED="
for /l %%i in (1,1,5) do (
  if not defined COPIED (
    copy /y "%APK%" "%PUBLISH%" >nul 2>nul
    if not errorlevel 1 (
      set "COPIED=1"
    ) else (
      echo   publish target busy, retrying...
      timeout /t 2 /nobreak >nul
    )
  )
)
if not defined COPIED (
  echo.
  echo Build OK but could not copy the APK to %PUBLISH%
  echo Something is holding that file open. Copy it by hand from:
  echo   %APK%
  exit /b 1
)

echo.
echo Done. APK:       %APK%
echo Published to:    %PUBLISH%
endlocal
