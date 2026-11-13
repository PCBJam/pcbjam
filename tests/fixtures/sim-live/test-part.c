/*
 * A code part for the live engine's tests (tests/kicad/sim-live-engine.spec.ts).
 *
 * Two inputs, one output. The output changes every 100 ms of simulated time.
 * While input 0 is high the output stays on. Input 1 going high makes the part
 * trap: a crash on purpose, to see the engine come back after one.
 *
 * It is written straight against the three functions the engine calls and the
 * one it offers (wasm/ngspice-service/ngspice_live.cpp), with no C library:
 *
 *   pj_setup()                            -> port counts, packed
 *   pj_step(target_time)                  -> the time reached (earlier when the output changed)
 *   pj_input(time, bit, state, strength)
 *   import pj.out(time, bit, state, strength)
 *
 * test-part.wasm is this file, built once with the clang of the build image:
 *
 *   /emsdk/upstream/bin/clang --target=wasm32 -O2 -nostdlib -Wl,--no-entry \
 *       -Wl,--export=pj_setup -Wl,--export=pj_step -Wl,--export=pj_input \
 *       -o test-part.wasm test-part.c
 */

__attribute__(( import_module( "pj" ), import_name( "out" ) ))
void pj_out( double t, int bit, int state, int strength );

static double now, next_toggle;
static int    held, led;

static void drive( double t, int v )
{
    led = v;
    pj_out( t, 0, v ? 1 : 0, 0 ); /* state ONE or ZERO, strength STRONG */
}

int pj_setup( void )
{
    now = 0;
    next_toggle = 0.1;
    held = 0;
    led = 0;
    return 2 | ( 1 << 8 ); /* 2 inputs, 1 output, no inouts, the normal stepping method */
}

double pj_step( double target )
{
    if( held && !led )
    {
        drive( now, 1 );
        return now;
    }

    if( next_toggle <= target )
    {
        now = next_toggle;
        next_toggle += 0.1;

        if( !held )
        {
            drive( now, !led );
            return now;
        }
    }

    now = target;
    return target;
}

void pj_input( double t, int bit, int state, int strength )
{
    (void) strength;

    if( bit == 0 )
        held = ( state == 1 );

    if( bit == 1 && state == 1 && t > 0 )
        __builtin_trap();
}
