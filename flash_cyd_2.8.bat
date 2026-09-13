@echo off
setlocal enabledelayedexpansion
title Smart Deck - Flash CYD 2.8" (ESP32-2432S028R)
color 0B

echo ======================================================================
echo           SMART DECK - FLASH TOOL: ESP32 CYD 2.8" (320x240)
echo ======================================================================
echo.

set "ESPTOOL=%~dp0app_source\assets\tools\esptool.exe"
set "FW_DIR=%~dp0app_source\assets\firmware\ESP32_2432S028R"

if not exist "%ESPTOOL%" (
    set "ESPTOOL=%LOCALAPPDATA%\Programs\Smart Deck\resources\assets\tools\esptool.exe"
)
if not exist "%FW_DIR%" (
    set "FW_DIR=%LOCALAPPDATA%\Programs\Smart Deck\resources\assets\firmware\ESP32_2432S028R"
)

if not exist "%ESPTOOL%" (
    color 0C
    echo [BLAD] Nie znaleziono narzedzia esptool.exe!
    pause
    exit /b 1
)

if not exist "%FW_DIR%\firmware.bin" (
    color 0C
    echo [BLAD] Nie znaleziono plikow firmware w %FW_DIR%!
    pause
    exit /b 1
)

echo Wykrywanie portow COM...
for /f "usebackq tokens=*" %%P in (`powershell -NoProfile -Command "[System.IO.Ports.SerialPort]::GetPortNames()"`) do (
    set "DETECTED_PORT=%%P"
    echo  - Znaleziono port: %%P
)

echo.
if defined DETECTED_PORT (
    set /p "TARGET_PORT=Podaj port COM do flashowania [domyslnie %DETECTED_PORT%]: "
    if "!TARGET_PORT!"=="" set "TARGET_PORT=%DETECTED_PORT%"
) else (
    set /p "TARGET_PORT=Podaj port COM (np. COM3, COM4): "
)

if "!TARGET_PORT!"=="" (
    echo Nie wybrano portu COM! Przerywanie.
    pause
    exit /b 1
)

echo.
echo Zamykanie ewentualnych procesow blokujacych port...
powershell -NoProfile -Command "Stop-Process -Name 'Smart Deck' -Force -ErrorAction SilentlyContinue" >nul 2>&1
timeout /t 1 /nobreak >nul

echo.
echo ======================================================================
echo Rozpoczynam flashowanie na port !TARGET_PORT!...
echo NIE ODLACZAJ URZADZENIA!
echo ======================================================================
echo.

"%ESPTOOL%" --chip esp32 --port !TARGET_PORT! --baud 921600 --before default-reset --after hard-reset write-flash -z --flash-mode dio --flash-freq 40m 0x1000 "%FW_DIR%\bootloader.bin" 0x8000 "%FW_DIR%\partitions.bin" 0xe000 "%FW_DIR%\boot_app0.bin" 0x10000 "%FW_DIR%\firmware.bin"

if errorlevel 1 (
    color 0C
    echo.
    echo ======================================================================
    echo [BLAD] Flashowanie nie powiodlo sie!
    echo Upewnij sie, ze wybrano poprawny port COM oraz ze kabel USB obsluguje
    echo przesyl danych (nie tylko ladowanie).
    echo ======================================================================
) else (
    color 0A
    echo.
    echo ======================================================================
    echo [SUKCES] Firmware dla CYD 2.8" zostal pomyslnie wgrany!
    echo Urzadzenie restartuje sie i jest gotowe do pracy.
    echo ======================================================================
)

echo.
pause
