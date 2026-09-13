/*******************************************************************************
 * config.h - SmartDeck Hardware Configuration
 * 
 * Pin definitions, display selection and layout constants.
 * Grid layout is auto-calculated based on SCREEN_INCH.
 ******************************************************************************/

#ifndef CONFIG_H
#define CONFIG_H

//=============================================================================
// DEVICE INFO
//=============================================================================
#define DEVICE_NAME   "Smart Deck"

//=============================================================================
// DISPLAY SELECTION (uncomment ONE)
//=============================================================================
#define ESP32_2432S028          // CYD 2.8" 320x240 (ILI9341 SPI + XPT2046 Touch)
// #define ESP32_3248S035       // 3.5" 480x320 (ST7796 SPI)
// #define ESP32_JC8048W550     // Guition JC8048W550 - 5" 800x480 (RGB)
// #define ESP32_8048S070       // 7.0" 800x480 (RGB)

//=============================================================================
// SCREEN SETTINGS
//=============================================================================
#if defined(ESP32_2432S028)
#define SCREEN_INCH       3       // 3, 5, or 7 (affects grid layout)
#define SCREEN_WIDTH      320
#define SCREEN_HEIGHT     240
#define SCREEN_ROTATION   1       // 0, 1, 2, 3 (0°, 90°, 180°, 270°)
#elif defined(ESP32_3248S035)
#define SCREEN_INCH       3
#define SCREEN_WIDTH      480
#define SCREEN_HEIGHT     320
#define SCREEN_ROTATION   0
#else
#define SCREEN_INCH       5
#define SCREEN_WIDTH      800
#define SCREEN_HEIGHT     480
#define SCREEN_ROTATION   0
#endif

//=============================================================================
// TOUCH SETTINGS
//=============================================================================
#define TOUCH_ROTATION    ROTATION_INVERTED   // ROTATION_NORMAL, ROTATION_INVERTED

//=============================================================================
// GRID LAYOUT (Auto-calculated based on SCREEN_INCH)
//=============================================================================
#if SCREEN_INCH == 3
  #define CELL_W              70
  #define CELL_H              70
  #define CELL_PADDING        8
  #define CORNER_RADIUS       12
  #define TITLE_BOX_HEIGHT    20
  #define TITLE_BOX_MARGIN_Y  2
  #define STROKE_WIDTH        2
#elif SCREEN_INCH == 5
  #define CELL_W              110
  #define CELL_H              110
  #define CELL_PADDING        17
  #define CORNER_RADIUS       20
  #define TITLE_BOX_HEIGHT    35
  #define TITLE_BOX_MARGIN_Y  3
  #define STROKE_WIDTH        2
#elif SCREEN_INCH == 7
  #define CELL_W              90
  #define CELL_H              90
  #define CELL_PADDING        17
  #define CORNER_RADIUS       15
  #define TITLE_BOX_HEIGHT    35
  #define TITLE_BOX_MARGIN_Y  3
  #define STROKE_WIDTH        2
#else
  #error "Invalid SCREEN_INCH! Use 3, 5, or 7"
#endif

//=============================================================================
// TOUCH PANEL PINS
//=============================================================================
#if defined(ESP32_2432S028)
#define TOUCH_XPT2046
#define XPT2046_IRQ       36
#define XPT2046_MOSI      32
#define XPT2046_MISO      39
#define XPT2046_CLK       25
#define XPT2046_CS        33
#else
#define TOUCH_SDA         19
#define TOUCH_SCL         20
#define TOUCH_INT         0
#define TOUCH_RST         38
#endif
#define TOUCH_WIDTH       SCREEN_WIDTH
#define TOUCH_HEIGHT      SCREEN_HEIGHT

//=============================================================================
// SD CARD
//=============================================================================
#if defined(ESP32_2432S028)
#define SD_CS             5
#else
#define SD_CS             10
#endif

//=============================================================================
// NEOPIXEL LED
//=============================================================================
#define LED_PIN           18
#define LED_COUNT         16
#define LED_OFFSET        0   // LED ring rotation offset in degrees (0-359)

//=============================================================================
// ROTARY ENCODER (AS5600)
//=============================================================================
#define KNOB_SDA          17
#define KNOB_SCL          19
#define KNOB_THRESHOLD    25

//=============================================================================
// BACKLIGHT PWM
//=============================================================================
#define BL_PWM_CHANNEL    0
#define BL_PWM_FREQ       1500
#define BL_PWM_RESOLUTION 8

//=============================================================================
// COMMUNICATION
// 0: Direct USB Serial to PC
// 1: ESP-NOW to dongle
//=============================================================================
#define DONGLE_MODE       0
#define RECEIVER_MAC      { 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF }

#endif // CONFIG_H