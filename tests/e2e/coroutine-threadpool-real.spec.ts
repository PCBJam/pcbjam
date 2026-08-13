import { test, expect } from './utils/fixtures';

// The BS-pool-API native-EH test (docs/features/wasm-exceptions/10 §6 #1).
//
// Unlike threadpool.spec.ts / coroutine-raytrace.spec.ts (which hand-roll raw std::thread),
// this drives KiCad's REAL pool: the app compiles in kicad/common/thread_pool.cpp and calls
// the actual GetKiCadThreadPool() (a BS::priority_thread_pool), with the detach_task
// __EMSCRIPTEN__ inline shim opted OUT via -DKICAD_WASM_REAL_THREADPOOL so tasks run on the
// pool's persistent pthread workers.
//
// The real pool is mode-a/b-safe by construction (persistent workers -> no on-demand spawn;
// futex busy-wait join -> no Asyncify nesting). The only native-EH risk is mode-c: a task
// that THROWS on a worker (caught by submit_task's promise wrapper ON the worker drives
// Asyncify under -fexceptions). So mode 6 is the decisive native-EH proof; modes 0-5 prove
// real multi-core (workersRan>1) across the API surface. Green => we can drop the shim.
//
// Named coroutine-* so playwright-coroutine.config.ts runs it in real Chrome + Firefox.
// WebKit is skipped for pthread apps (COEP worker-load limitation; doc 10 §2a).

const APP = '/standalone/threadpool-real/threadpool_real_test.html';

const MODES: { m: number; name: string }[] = [
  { m: 0, name: 'submit_task + vector<future> poll' },
  { m: 1, name: 'submit_loop + multi_future.wait' },
  { m: 2, name: 'submit_blocks (typed returns)' },
  { m: 3, name: 'detach_task + tp.wait()' },
  { m: 4, name: 'manual multi_future fanout by get_thread_count' },
  { m: 5, name: 'lifecycle: get_tasks_*/purge/wait + pause pool' },
];

function parse( logs: string[], mode: number ) {
  const line = logs.find( l => l.includes( `[POOL] SUCCESS mode=${mode}` ) );
  if( !line ) return null;
  const w = line.match( /workersRan=(\d+)/ );
  const c = line.match( /caught=(\d+)/ );
  return { workersRan: w ? +w[1] : -1, caught: c ? +c[1] : -1 };
}

async function waitForLog( testLogger: { consoleLogs: string[] }, needle: string, timeout = 60000 ) {
  await expect.poll( () => testLogger.consoleLogs.some( l => l.includes( needle ) ), { timeout } ).toBe( true );
}

test.describe( 'Real BS::thread_pool (GetKiCadThreadPool) — multi-core under native-EH', () => {

  for( const { m, name } of MODES ) {
    test( `mode ${m}: ${name} runs multi-core on the real pool`, async ( { page, testLogger } ) => {
      await page.goto( `${APP}#m=${m}` );
      await waitForLog( testLogger, `[POOL] SUCCESS mode=${m}` );
      const r = parse( testLogger.consoleLogs, m )!;
      expect( r.workersRan, 'tasks must run on >1 pool worker' ).toBeGreaterThan( 1 );
      expect( testLogger.errors.filter( e => !e.includes( 'favicon' ) ), 'no runtime errors' ).toHaveLength( 0 );
    } );
  }

  // mode-c: a task throws ON a worker; submit_task's promise wrapper catches it on the
  // worker (drives Asyncify under -fexceptions -> "func is not a function" crash) and
  // rethrows on main. Native wasm-EH decouples exceptions from Asyncify, so this must
  // complete cleanly. (Red under JS-EH, green under native-EH — the contrast IS the proof.)
  test( 'mode 6: throw on a worker is safe under native-EH and rethrows on main', async ( { page, testLogger } ) => {
    await page.goto( `${APP}#m=6` );
    // A worker throw is a mode-c crash under JS-EH and only safe under native wasm-EH. Native EH
    // is a required build invariant now; silently skipping here would let a stale JS-EH artifact
    // remove the exact regression proof this test exists to provide.
    await waitForLog( testLogger, '[POOL] EH=' );
    expect( testLogger.consoleLogs.some( l => l.includes( '[POOL] EH=native' ) ),
            'the shipped real-thread-pool harness must use native wasm EH' ).toBe( true );
    await waitForLog( testLogger, '[POOL] SUCCESS mode=6' );
    const r = parse( testLogger.consoleLogs, 6 )!;
    expect( r.caught, 'the worker throw must rethrow + be caught on main' ).toBe( 1 );
    expect( r.workersRan, 'workers still run a normal batch after the throw' ).toBeGreaterThan( 1 );
    expect( testLogger.errors.filter( e => !e.includes( 'favicon' ) ), 'no mode-c crash' ).toHaveLength( 0 );
  } );
} );
