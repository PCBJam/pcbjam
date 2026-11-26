# uno-demo: the sketch of the Arduino and ATmega328P browser tests

`firmware.hex` is the program `tests/web/live-sim-arduino.spec.ts` gives the simulated
Arduino Uno, and `tests/web/live-sim-atmega.spec.ts` the simulated ATmega328P without a
board. It is in the repository so that the tests need no compiler. Its source is
`src/uno_demo.cpp`.

## What the sketch does

- D2: a button to ground, read with the chip's own pull-up, an interrupt on every change
- D8: an LED, on while the button is held and 200 ms longer
- D13: the board's LED as a heartbeat, it toggles every 250 ms
- Serial, 115200 baud: `uno-demo: ready` once, and `uno-demo: presses <n>` after every
  press of the button
- The letter `a` typed on the serial line: `uno-demo: analog avcc A0=<n> A6=<n> A7=<n>`,
  what `analogRead` gives measured against the supply of the converter (AVCC). The letter
  `e`: `uno-demo: analog aref ...`, the same measured against the voltage on the AREF pin.
  A6 and A7 are the two extra inputs of the chip's packages with 32 pins

The speeds are those of a chip that runs at 16 MHz, which the sketch is built for.

It is an ordinary Arduino sketch. Nothing in it knows that it runs in an emulator.

## How it was built

With PlatformIO Core 6.1.19 and the project file of this folder:

    pio run -d tests/fixtures/sim-live/uno-demo -e uno-demo
    cp tests/fixtures/sim-live/uno-demo/.pio/build/uno-demo/firmware.hex \
       tests/fixtures/sim-live/uno-demo/firmware.hex

`platformio.ini` pins the platform (atmelavr 5.3.0), and the platform pins the rest:

| What | Version |
| --- | --- |
| Compiler | avr-gcc 7.3.0 (toolchain-atmelavr 1.70300.191015) |
| Arduino core | Arduino AVR Boards 1.8.8 (framework-arduino-avr 5.4.0) |
| C library | avr-libc 2.0.0 |

The build gives the same file on every run and in every folder. Its SHA-256 is

    2a9acab656d13383e1281d24fdcf0dfbd567a81af3e5902fc4f0b1321207decc

The program is 3118 bytes of the chip's 32256.

To change the sketch: edit `src/uno_demo.cpp`, build, copy the `.hex` here and write its
new checksum into this file. The build folder (`.pio`) is not kept.

## What is inside the .hex

A compiled Arduino program holds more than the sketch. The linker puts in the parts of
these that the sketch uses:

| Part | Licence | Source |
| --- | --- | --- |
| The sketch, `src/uno_demo.cpp` | this repository's | here |
| Arduino AVR core (`main`, `millis`, `digitalWrite`, `analogRead`, `Serial`, the interrupt handlers) | LGPL-2.1-or-later | https://github.com/arduino/ArduinoCore-avr |
| avr-libc (the start-up code) | a BSD licence with three clauses | https://github.com/avrdudes/avr-libc |
| libgcc of avr-gcc (arithmetic helpers) | GPL-3.0-or-later with the GCC Runtime Library Exception | https://gcc.gnu.org |

The versions are the ones in the table above, so the same core can be fetched again and the
program linked again with a changed core.

The licence texts. avr-libc asks that a compiled copy comes with its copyright notice: it is
`LICENSE-avr-libc` in this folder, the file `LICENSE` of avr-libc 2.0.0 as it is. The
Arduino core is under the GNU Lesser General Public License, version 2.1 or later
(https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html). libgcc is under the GNU General
Public License, version 3 or later, with the GCC Runtime Library Exception
(https://www.gnu.org/licenses/gcc-exception-3.1.html), which lets a program that is linked
with it be passed on under terms of its own.
