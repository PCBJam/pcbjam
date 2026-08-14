import { test, expect } from './utils/fixtures';

// Phase 2: on-demand (NON-warm) pthread Worker creation WITHOUT modifying KiCad.
//
// The real KiCad pool (compiled-in kicad/common/thread_pool.cpp, via GetKiCadThreadPool())
// consumes ALL the pre-warmed Workers at construction; raw fly-threads beyond that count
// must then be created ON DEMAND, whose 'loaded'->'run' handshake needs the main event loop.
// The fix is wasm/shims/nanosleep_yield.c (a strong nanosleep override): the main-thread sleep_for
// join suspends to the browser loop so it services the handshake and the on-demand Workers boot.
//
// Named coroutine-*: the merged config's coroutine-* projects select by testMatch
// /coroutine.*\.spec\.ts$/ — keep these filenames.
// WebKit is skipped for pthread apps (COEP worker-load limitation; doc 10 §2a).

const APP = '/standalone/pthread-ondemand/pthread_ondemand_test.html';

function parse( logs: string[], mode: number ) {
  const line = logs.find( l => l.includes( `[ONDEMAND] SUCCESS m=${mode}` ) );
  if( !line ) return null;
  const w = line.match( /workersRan=(\d+)/ );
  return { workersRan: w ? +w[1] : -1 };
}

async function waitForLog( testLogger: { consoleLogs: string[] }, needle: string, timeout = 60000 ) {
  await expect.poll( () => testLogger.consoleLogs.some( l => l.includes( needle ) ), { timeout } ).toBe( true );
}

test.describe( 'On-demand non-warm pthread Worker (real pool drains the pre-warmed pool)', () => {

  test( 'fix: nanosleep override yields → on-demand Workers boot → multi-core', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=1` );
    await waitForLog( testLogger, '[ONDEMAND] SUCCESS m=1' );
    const r = parse( testLogger.consoleLogs, 1 )!;
    expect( r.workersRan, 'on-demand Workers boot and run via the yielding join' ).toBeGreaterThan( 1 );
  } );

  // Negative control: a busy-wait join that never calls nanosleep → never yields → the
  // on-demand Workers never boot. Held to the SAME bar (workersRan>1), expected to miss it,
  // so it is reported as an EXPECTED failure. If it ever passes, on-demand got fixed another way.
  test( 'control: busy-wait (no nanosleep) CANNOT boot on-demand Workers', async ( { page, testLogger } ) => {
    test.fail();
    await page.goto( `${APP}#m=0`, { waitUntil: 'domcontentloaded' } );
    await waitForLog( testLogger, '[ONDEMAND] SUCCESS m=0', 20000 );
    const r = parse( testLogger.consoleLogs, 0 )!;
    expect( r.workersRan, 'a non-yielding busy-wait cannot create on-demand Workers' ).toBeGreaterThan( 1 );
  } );
} );
