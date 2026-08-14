import { test, expect } from './utils/fixtures';

// A raytracer-style worker-join run inside a wx modal pump. A pass is dispatched from a wxTimer that
// fires while a ShowModal() dialog is open; the modal pump runs ProcessEvents via ccall(async:true),
// so the work runs in a fresh suspendable entry (its own suspender, clean state). Both join styles
// complete multi-core there:
//   m=0 busywait : sleep_for join; the pre-warmed pool completes it.
//   m=1 yield    : emscripten_sleep join; legal at state == Normal, so it suspends and resumes.
//
// Named coroutine-*: the merged config's coroutine-* projects select by testMatch
// /coroutine.*\.spec\.ts$/ — keep these filenames. WebKit skipped for pthread apps (COEP).

const APP = '/standalone/raytrace-modal/raytrace_modal_test.html';

function workersRan( logs: string[] ): number {
  const l = logs.find( x => x.includes( '[RTPOOL] SUCCESS' ) );
  const m = l?.match( /workersRan=(\d+)/ );
  return m ? +m[1] : -1;
}

function abortErrors( testLogger: { errors: string[] } ) {
  return testLogger.errors.filter( e => /invalid state:\s*1|Aborted/i.test( e ) );
}

async function waitForLog( testLogger: { consoleLogs: string[] }, needle: string, timeout = 60000 ) {
  await expect.poll( () => testLogger.consoleLogs.some( l => l.includes( needle ) ), { timeout } ).toBe( true );
}

test.describe( 'Raytracer worker-join inside a wx modal pump', () => {

  test( 'm=0 busywait: pre-warmed pool busy-wait completes inside the modal → multi-core', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=0` );
    await waitForLog( testLogger, '[RTPOOL] SUCCESS mode=0' );
    expect( workersRan( testLogger.consoleLogs ), 'multi-core inside the modal' ).toBeGreaterThan( 1 );
    expect( abortErrors( testLogger ), 'no wasm abort' ).toHaveLength( 0 );
  } );

  // The in-modal work runs in a fresh ProcessEvents entry, so an emscripten_sleep join is a
  // legal scheduler park and the pass completes multi-core. (The asyncify-era `Asyncify.state=0`
  // probe log retired with that backend — under JSPI the equivalent invariant is that the
  // sleep park suspends cleanly, i.e. SUCCESS is reached with no scheduler anomaly.)
  test( 'm=1 yield: emscripten_sleep join inside the modal → multi-core', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=1` );
    await waitForLog( testLogger, '[RTPOOL] SUCCESS mode=1' );
    expect( testLogger.consoleLogs.filter( l =>
              /\[wx-scheduler\] (force-clearing stuck window|job tick error)|\[libctx-jspi\] ghost\/refused/.test( l ) ),
            'no scheduler anomaly during the in-modal join' ).toHaveLength( 0 );
    expect( workersRan( testLogger.consoleLogs ), 'the yield-join completes → multi-core' ).toBeGreaterThan( 1 );
    expect( abortErrors( testLogger ), 'no wasm abort' ).toHaveLength( 0 );
  } );
} );
