import { test, expect } from './utils/fixtures';

// 1b: library-preload native-EH repro (docs/features/wasm-exceptions/10 §7).
// A STANDALONE std::async worker that parses+THROWS (mode-c) and proxies a fetch to main — the
// KiCad-10 PCBJAM preload shape, with NO KiCad source. Proves native wasm-EH makes the worker-side
// parse-throw safe, and that the proxy round-trip / lazy join / modal-reentrancy all work.
//
// Named coroutine-*: the merged config's coroutine-* projects select by testMatch
// /coroutine.*\.spec\.ts$/ — keep these filenames. WebKit skipped for pthread apps (COEP).

const APP = '/standalone/async-preload/async_preload_test.html';

function parse( logs: string[], mode: number ) {
  const line = logs.find( l => l.includes( `[PRELOAD] SUCCESS m=${mode}` ) );
  if( !line ) return null;
  const c = line.match( /caught=(\d+)/ );
  const ld = line.match( /loaded=(\d+)/ );
  return { caught: c ? +c[1] : -1, loaded: ld ? +ld[1] : -1 };
}

async function waitForLog( testLogger: { consoleLogs: string[] }, needle: string, timeout = 60000 ) {
  await expect.poll( () => testLogger.consoleLogs.some( l => l.includes( needle ) ), { timeout } ).toBe( true );
}

// Fatal native-EH / suspension-runtime failures we must NOT see.
function fatal( testLogger: { errors: string[] } ) {
  return testLogger.errors.filter( e => !e.includes( 'favicon' )
    && /invalid state|table index out of bounds|aborted|unreachable|func is not a function/i.test( e ) );
}

test.describe( 'std::async library-preload — native-EH safe (KiCad-10 shape, standalone)', () => {

  test( 'm=0 simple: worker proxies + parses, lazy join completes', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=0` );
    await waitForLog( testLogger, '[PRELOAD] SUCCESS m=0' );
    const r = parse( testLogger.consoleLogs, 0 )!;
    expect( r.loaded, 'libraries parsed' ).toBeGreaterThan( 0 );
    expect( fatal( testLogger ), 'no fatal errors' ).toHaveLength( 0 );
  } );

  // The decisive native-EH proof: the parse THROWS on the worker; the worker's try/catch is safe
  // under native wasm-EH (mode-c) but crashes under JS-EH (-fexceptions). Gated to native.
  test( 'm=1 throw: worker parse-throw is caught (mode-c safe under native-EH)', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=1` );
    await waitForLog( testLogger, '[PRELOAD] EH=' );
    test.skip( !testLogger.consoleLogs.some( l => l.includes( '[PRELOAD] EH=native' ) ),
               'worker throw-on-parse (mode-c) is native-EH-only; JS-EH build skips it' );
    await waitForLog( testLogger, '[PRELOAD] SUCCESS m=1' );
    const r = parse( testLogger.consoleLogs, 1 )!;
    expect( r.caught, 'the worker parse exception was caught' ).toBe( 1 );
    expect( fatal( testLogger ), 'no mode-c crash' ).toHaveLength( 0 );
  } );

  test( 'm=2 shutdown: blocking-join the future mid-load completes', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=2` );
    await waitForLog( testLogger, '[PRELOAD] SUCCESS m=2' );
    expect( testLogger.consoleLogs.some( l => l.includes( '[PRELOAD] shutdown joined' ) ),
            'the blocking join returned (no deadlock)' ).toBe( true );
    expect( fatal( testLogger ), 'no crash on the shutdown join' ).toHaveLength( 0 );
  } );

  test( 'm=3 modal during preload: g_proxyMutex prevents the reentrancy crash', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=3` );
    await waitForLog( testLogger, '[PRELOAD] SUCCESS m=3', 90000 );
    expect( fatal( testLogger ), 'no table-index-out-of-bounds reentrancy crash' ).toHaveLength( 0 );
  } );
} );
