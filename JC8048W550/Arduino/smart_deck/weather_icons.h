/*
 * Weather Icons Header for SmartDeck
 * Auto-generated - Do not edit manually
 */

#ifndef WEATHER_ICONS_H
#define WEATHER_ICONS_H

#include <stdint.h>
#include <stdbool.h>

#define WEATHER_ICON_SIZE 48
#define WEATHER_ICON_PIXELS 2304

#ifdef __cplusplus
extern "C" {
#endif

// Weather icons (48x48 RGB565)
extern const uint16_t icon_sun[];
extern const uint16_t icon_moon[];
extern const uint16_t icon_partly_cloudy_day[];
extern const uint16_t icon_partly_cloudy_night[];
extern const uint16_t icon_cloudy[];
extern const uint16_t icon_fog[];
extern const uint16_t icon_rain[];
extern const uint16_t icon_snow[];
extern const uint16_t icon_thunder[];

// Temperature unit icons (48x48 RGB565)
extern const uint16_t icon_celsius[];
extern const uint16_t icon_fahrenheit[];

// Function declarations
const uint16_t* getWeatherIcon(int weatherCode, int isDay);
const uint16_t* getTempUnitIcon(int isCelsius);

#ifdef __cplusplus
}
#endif

#endif
