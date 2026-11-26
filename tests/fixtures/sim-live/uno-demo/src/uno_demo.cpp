// The sketch of the live simulation's browser tests with an Arduino Uno and with a bare
// ATmega328P (tests/web/live-sim-arduino.spec.ts, live-sim-atmega.spec.ts). An ordinary
// Arduino sketch, nothing in it knows that it runs in an emulator.
//
//   D2   a button to ground, read with the chip's own pull-up, an interrupt on every change
//   D8   an LED: on while the button is held and 200 ms longer
//   D13  the board's LED as a heartbeat: it toggles every 250 ms
//
// On the serial line (115200 baud) it says "uno-demo: ready" once, and
// "uno-demo: presses <n>" after every press of the button.
//
// It answers two letters typed on the serial line with what analogRead gives on A0, A6
// and A7 (A6 and A7 are the two extra inputs of the chip's packages with 32 pins):
//   a   measured against the supply of the converter (AVCC), the Arduino's usual way
//   e   measured against the voltage on the AREF pin
// as "uno-demo: analog avcc A0=<n> A6=<n> A7=<n>", or "... analog aref ...".
#include <Arduino.h>

static const uint8_t kButton = 2, kLed = 8, kBeat = LED_BUILTIN;
static volatile uint16_t gPresses = 0;
static volatile uint32_t gReleasedAt = 0;
static volatile bool gHeld = false;

static void onButton() {
  const bool down = digitalRead(kButton) == LOW;
  if (down && !gHeld) { gPresses++; digitalWrite(kLed, HIGH); }
  if (!down && gHeld) gReleasedAt = millis();
  gHeld = down;
}

static void sayAnalog(uint8_t reference, const __FlashStringHelper* name) {
  analogReference(reference);
  Serial.print(F("uno-demo: analog "));
  Serial.print(name);
  Serial.print(F(" A0="));
  Serial.print(analogRead(A0));
  Serial.print(F(" A6="));
  Serial.print(analogRead(A6));
  Serial.print(F(" A7="));
  Serial.println(analogRead(A7));
}

void setup() {
  Serial.begin(115200);
  pinMode(kButton, INPUT_PULLUP);
  pinMode(kLed, OUTPUT);
  pinMode(kBeat, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(kButton), onButton, CHANGE);
  Serial.println(F("uno-demo: ready"));
}

void loop() {
  static uint32_t beatAt = 0;
  static uint16_t said = 0;
  const uint32_t now = millis();
  if (now - beatAt >= 250) { beatAt += 250; digitalWrite(kBeat, !digitalRead(kBeat)); }

  noInterrupts();
  if (!gHeld && millis() - gReleasedAt >= 200) digitalWrite(kLed, LOW);
  const uint16_t presses = gPresses;
  interrupts();
  if (presses != said) { said = presses; Serial.print(F("uno-demo: presses ")); Serial.println(presses); }

  if (Serial.available()) {
    const int letter = Serial.read();
    if (letter == 'a') sayAnalog(DEFAULT, F("avcc"));
    if (letter == 'e') sayAnalog(EXTERNAL, F("aref"));
  }
}
