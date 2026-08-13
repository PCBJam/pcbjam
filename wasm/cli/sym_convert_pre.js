// Environment host shim for the standalone KiCad Node CLIs.
// wxConfig uses the separate shared in_memory_config_pre.js pre-js file.
// Emscripten does NOT inherit the host environment into the wasm getenv()
// table (node included) — without this, KICAD_CONFIG_HOME / SYM_CONVERT_TRACE
// set by the caller silently never arrive. Copy process.env in before main.
Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push( function() {
  if( typeof process !== 'undefined' && process.env && typeof ENV !== 'undefined' )
  {
    for( var k in process.env ) ENV[k] = process.env[k];
  }
} );
