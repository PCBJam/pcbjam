import { test, expect } from './utils/fixtures';

// 1b: library-preload native-EH repro (docs/features/wasm-exceptions/10 §7).
// A STANDALONE std::async worker that parses+THROWS (mode-c) and proxies a fetch to main — the
// KiCad-10 PCBJAM preload shape, with NO KiCad source. Proves native wasm-EH makes the worker-side
// parse-throw safe, and that the proxy round-trip / lazy join / modal-reentrancy all work.  Its
// concurrent mode also proves that provider Promises overlap while exact native completions remain
// serialized and return to their own worker requests.
//
// Named coroutine-* so playwright-coroutine.config.ts runs it in real Chrome + Firefox.
// WebKit skipped for pthread apps (COEP).

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

// Fatal native-EH / Asyncify failures we must NOT see.
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
  // under native wasm-EH (mode-c) but crashes under JS-EH (-fexceptions). Native EH is now a
  // required build invariant, so a JS-EH artifact is a loud failure rather than a skipped proof.
  test( 'm=1 throw: worker parse-throw is caught (mode-c safe under native-EH)', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=1` );
    await waitForLog( testLogger, '[PRELOAD] EH=' );
    expect( testLogger.consoleLogs.some( l => l.includes( '[PRELOAD] EH=native' ) ),
            'the shipped library-preload harness must use native wasm EH' ).toBe( true );
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

  test( 'm=3 modal during preload: independent proxy round-trips remain safe', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=3` );
    await waitForLog( testLogger, '[PRELOAD] SUCCESS m=3', 90000 );
    expect( fatal( testLogger ), 'no table-index-out-of-bounds reentrancy crash' ).toHaveLength( 0 );
  } );

  test( 'm=4 concurrent providers: all start, then resolve out of order to exact workers', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=4` );
    await waitForLog( testLogger, '[PRELOAD] CONCURRENCY_RESULT', 90000 );

    const line = testLogger.consoleLogs.find( l => l.includes( '[PRELOAD] CONCURRENCY_RESULT' ) );
    expect( line, 'concurrency result was reported' ).toBeTruthy();

    const metric = ( name: string ) => {
      const match = line!.match( new RegExp( `${name}=(\\d+)` ) );
      expect( match, `${name} metric exists` ).toBeTruthy();
      return Number( match![1] );
    };

    expect( metric( 'started' ), 'all provider Promises started' ).toBe( 4 );
    expect( metric( 'resolved' ), 'all provider Promises resolved' ).toBe( 4 );
    expect( metric( 'firstResolveStarted' ), 'no provider resolved before all started' ).toBe( 4 );
    expect( metric( 'allStartedBeforeResolve' ), 'the held-Promise barrier was observed' ).toBe( 1 );
    expect( metric( 'outOfOrder' ), 'providers resolved in a different order from their starts' ).toBe( 1 );
    expect( metric( 'exact' ), 'every worker received its own exact reply' ).toBe( 4 );
    expect( metric( 'mismatches' ), 'no result slot or request identity was overwritten' ).toBe( 0 );
    expect( metric( 'nativeCompletions' ), 'every request completed exactly once' ).toBe( 4 );
    expect( metric( 'nativeCollisions' ), 'native completion gate remained exclusive' ).toBe( 0 );
    expect( fatal( testLogger ), 'no native or Asyncify failure' ).toHaveLength( 0 );
  } );
} );
