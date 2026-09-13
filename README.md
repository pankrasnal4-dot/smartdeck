# Smart Deck Studio Pro

<div align="center">

# ⚡ Smart Deck Studio Pro

**Advanced, Customizable Touchscreen Macro Deck & Hardware Companion for Windows**

[![GitHub Release](https://img.shields.io/github/v/release/pankrasnal4-dot/smartdeck?style=for-the-badge&color=blue)](https://github.com/pankrasnal4-dot/smartdeck/releases)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-green.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%20%7C%2011-0078D6?style=for-the-badge&logo=windows)](https://github.com/pankrasnal4-dot/smartdeck)
[![Hardware](https://img.shields.io/badge/Hardware-ESP32%20CYD%20%7C%20JC8048-E7352C?style=for-the-badge&logo=espressif)](https://github.com/pankrasnal4-dot/smartdeck)

</div>

---

## 📖 Overview

**Smart Deck Studio Pro** is an open-source, highly customizable macro deck ecosystem designed for Windows. It pairs a rich Electron desktop management studio with low-cost, high-performance ESP32 touchscreens—transforming hardware like the **ESP32 CYD 2.8\"** and **Guition JC8048W550 5.0\"** into powerful tactile macro controllers for productivity, streaming, gaming, audio editing, and programming.

---

## 🌟 Key Features

### 🖥️ Dual Hardware Architecture
- **ESP32 CYD 2.8\" (320x240)**: Compact, budget-friendly resistive touchscreen (XPT2046) with on-board RGB LED, microSD, and internal LittleFS flash storage support.
- **Guition JC8048W550 5.0\" (800x480)**: Large capacitive multi-touch IPS display with high-resolution layout and magnetic rotary knob (AS5600 + NeoPixel ring) support.

### ⚡ 1-Click Firmware Flashing
- **Automated Batch Flashers**: Plug in your device and run:
  - `flash_cyd_2.8.bat` for ESP32 CYD 2.8\" (320x240)
  - `flash_jc8048_5.0.bat` for Guition JC8048W550 5.0\" (800x480)
- **Auto-Detection**: Scripts automatically detect available COM ports and gracefully close any running background process to release port locks.
- **In-App Flasher**: Built-in firmware installer inside the desktop client with real-time log output and auto-serial release.

### 📁 Smartphone-Style Application Folders
- Group related buttons into hierarchical **Folders** directly on the grid.
- Opens dedicated nested sub-panels with an automatic **⬅️ Return** navigation button.
- 100% compatible with both 2.8\" CYD and 5.0\" JC8048 displays via zero-latency serial `goto` commands.

### ⛅ Live Weather Capsule
- Sleek, modern **Frosted-Glass Weather Widget** integrated into the desktop client.
- Provides real-time weather conditions, dynamic weather icons, and temperature updates with automated background refresh.

### 🎯 High-Legibility TFT Rendering Engine
- **Smart Auto-Fit**: Intelligently scales font size and refits multi-word text without awkward word breaks or truncation.
- **Dual-Stroke Outline**: Renders crisp contrast strokes and gradient scrim backdrops so text remains razor-sharp on small TFT panels under any lighting.
- **Anti-Collision Layout**: Automatically adjusts icon dimensions and vertical offsets when buttons include text labels.

### 🎨 100,000+ Icons & Multi-Mirror CDN
- Search and browse over **100,000+ vector icons** via high-speed CDN mirrors (`Iconify`, `SimpleSVG`, `UniSVG`) with automatic failover and local query caching.
- Intelligent automatic white tinting for monochrome icon sets on dark themes.
- Built-in crop and custom image importer with instant live preview.

### 🔄 Active-Window Profile Switching
- Automatically detects the foreground Windows application and transitions to its matching macro profile (e.g. Photoshop, Spotify, VS Code).
- **Auto-Revert**: Configurable automatic return to **Panel 1** as soon as the associated application is minimized or closed.

### 🎛️ 13+ Action Types & Multi-Action Builder
- **HotKey**: Keystrokes and combinations (Ctrl, Alt, Shift, Win + keys).
- **Text Typing**: Instant or natural human-speed automated text entry.
- **App Launching**: Fast path execution for desktop apps and games.
- **Web URLs**: Direct browser shortcuts with custom arguments.
- **Media Controls**: Play/pause, track navigation, mute, and system volume adjustments.
- **Timers & Counters**: Interactive timers and persistent count buttons with long-press resets.
- **Mouse Simulation**: Clicks, double-clicks, precision coordinates, and drag-and-drop.
- **Shell Scripts**: Run batch, PowerShell, or command-line scripts silently.
- **Multi-Action Sequences**: Chain unlimited actions with configurable millisecond delays.

### 📦 Built-In Production Presets
Pre-built macro maps ready to use out of the box:
- **Creative**: Adobe Photoshop, Premiere Pro, After Effects, Illustrator, DaVinci Resolve, Blender, Cinema 4D.
- **Audio & Streaming**: FL Studio, OBS Studio, Spotify Desktop, VLC Player.
- **Development & Daily**: Visual Studio Code, Google Chrome, Discord.

---

## 🚀 Quick Start Guide

### 1. Flash Your Display
1. Connect your ESP32 display to your PC using a reliable USB data cable.
2. In the repository folder, double-click the script for your board:
   - **ESP32 CYD 2.8\"**: Run `flash_cyd_2.8.bat`
   - **Guition 5.0\"**: Run `flash_jc8048_5.0.bat`
3. Enter or confirm your COM port. The script flashes the bootloader, partitions, and firmware binaries automatically.

### 2. Run the Desktop Studio
1. Open the `app_source` directory in your terminal:
   ```bash
   cd app_source
   npm install
   npm start
   ```
2. The application will launch, detect your device COM port, and establish a real-time connection.

---

## 🛠️ Repository Structure

```
smartdeck/
├── app_source/                 # Electron Desktop Management Studio
│   ├── assets/                 # Tools (esptool.exe, nircmd), firmware binaries, sounds
│   ├── locales/                # Internationalization strings (EN, DE, ES, FR, JA, TR, ZH)
│   ├── presets/                # Pre-configured application macro profiles
│   ├── app.js                  # Frontend client engine, UI renderer, canvas generator
│   ├── main.js                 # Electron main process, IPC handlers, system automation
│   ├── preload.js              # Secure contextBridge API bindings
│   ├── style.css               # Modern UI stylesheet
│   └── package.json            # Node.js project configuration
├── JC8048W550/                 # ESP32 Device Firmware
│   └── Arduino/
│       ├── libraries/          # Display, touch, and graphics libraries
│       └── smart_deck/         # Arduino firmware source (.ino, pins, configs)
├── 3d_print_files/             # 3D Printable Enclosure models (.3mf)
├── flash_cyd_2.8.bat           # 1-click flasher for CYD 2.8"
├── flash_jc8048_5.0.bat        # 1-click flasher for JC8048 5.0"
├── platformio.ini              # PlatformIO build configuration
├── .gitignore                  # Git ignore rules (node_modules, builds, logs)
├── LICENSE                     # GNU General Public License v3
└── README.md                   # Project documentation
```

---

## 🔧 Hardware Compatibility

| Display Model | Resolution | Touch Type | Storage | Connection |
| :--- | :--- | :--- | :--- | :--- |
| **ESP32-2432S028R (CYD)** | 320x240 (2.8\") | Resistive (XPT2046) | LittleFS / MicroSD | USB-C / Micro-USB Serial |
| **Guition JC8048W550** | 800x480 (5.0\") | Capacitive (GT911) | MicroSD / Flash | USB-C Serial |

---

## 📜 License

This project is licensed under the **GNU General Public License v3.0** - see the [LICENSE](LICENSE) file for details.

---

<div align="center">

Made with ❤️ by [pankrasnal4-dot](https://github.com/pankrasnal4-dot)

</div>
