// In-memory wxConfig host for headless Emscripten modules.
//
// Browsers provide a complete Storage object. Node 25 can expose a truthy
// `globalThis.localStorage` placeholder whose methods are absent when no
// --localstorage-file was supplied. Test the Storage contract, not only the
// object's presence, before selecting it.
(function( g ) {
  var ls;

  try
  {
    ls = g.localStorage;
  }
  catch( _error )
  {
    ls = null;
  }

  if( !ls
      || typeof ls.getItem !== 'function'
      || typeof ls.setItem !== 'function'
      || typeof ls.removeItem !== 'function'
      || typeof ls.key !== 'function' )
  {
    var store = new Map();
    ls = {
      get length() { return store.size; },
      key: function( i ) { var k = Array.from( store.keys() )[i]; return k === undefined ? null : k; },
      getItem: function( k ) { return store.has( k ) ? store.get( k ) : null; },
      setItem: function( k, v ) { store.set( String( k ), String( v ) ); },
      removeItem: function( k ) { store.delete( k ); },
      clear: function() { store.clear(); },
    };
    g.localStorage = ls;
  }

  // Only reached once a stored value exists; with the empty in-memory store
  // these do not run during normal startup. Keep them complete because a
  // module can write a setting and then read it in the same process.
  var s2u = function( str, buf, len ) {
    var f = g.stringToUTF8 || ( g.Module && g.Module.stringToUTF8 );
    f( str, buf, len );
  };

  g.hasConfigEntry = function( key ) { return ls.getItem( key ) !== null; };

  g.hasConfigGroup = function( key ) {
    for( var i = 0; i < ls.length; i++ ) if( ls.key( i ).startsWith( key ) ) return true;
    return false;
  };

  g.getConfigEntryCount = function( prefix, recurse ) {
    var n = 0;
    for( var i = 0; i < ls.length; i++ ) {
      var key = ls.key( i );
      if( key.startsWith( prefix ) ) {
        var end = key.indexOf( '/', prefix.length );
        if( end == -1 || recurse ) ++n;
      }
    }
    return n;
  };

  g.getConfigEntryIndex = function( prefix, index ) {
    var n = 0;
    for( var i = 0; i < ls.length; i++ ) {
      var key = ls.key( i );
      if( key.startsWith( prefix ) ) {
        var end = key.indexOf( '/', prefix.length );
        if( end == -1 ) { if( n >= index ) return i; else ++n; }
      }
    }
    return -1;
  };

  g.getConfigGroupCount = function( prefix, recurse ) {
    var c = new Set();
    for( var i = 0; i < ls.length; i++ ) {
      var key = ls.key( i );
      if( key.startsWith( prefix ) ) {
        var end = key.indexOf( '/', prefix.length );
        if( end != -1 ) { if( recurse ) end = key.lastIndexOf( '/' ); c.add( key.substring( prefix.length, end ) ); }
      }
    }
    return c.size;
  };

  g.getConfigGroupIndex = function( prefix, index ) {
    var c = new Set();
    for( var i = 0; i < ls.length; i++ ) {
      var key = ls.key( i );
      if( key.startsWith( prefix ) ) {
        var end = key.indexOf( '/', prefix.length );
        if( end != -1 ) {
          var child = key.substring( prefix.length, end );
          if( !c.has( child ) ) { if( c.size >= index ) return i; else c.add( child ); }
        }
      }
    }
    return -1;
  };

  g.getConfigKeyLength = function( index ) { var k = ls.key( index ); return k ? k.length : 0; };
  g.getConfigKey = function( index, buf, len ) { s2u( ls.key( index ), buf, len ); };

  g.getConfigEntryLength = function( key ) { var v = ls.getItem( key ); return v === null ? -1 : v.length; };
  g.getConfigEntry = function( key, buf, len ) {
    var v = ls.getItem( key );
    if( v !== null ) { s2u( v, buf, len ); return true; }
    return false;
  };

  g.setConfigEntry = function( key, value ) { ls.setItem( key, value ); };

  g.renameConfigGroup = function( oldG, newG ) {
    var keys = [];
    for( var i = 0; i < ls.length; i++ ) {
      var key = ls.key( i );
      if( key.startsWith( oldG ) ) keys.push( key );
      else if( key.startsWith( newG ) ) return false;
    }
    for( var j = 0; j < keys.length; j++ ) {
      var nk = newG + keys[j].substring( oldG.length );
      ls.setItem( nk, ls.getItem( keys[j] ) ); ls.removeItem( keys[j] );
    }
    return keys.length > 0;
  };
})( typeof globalThis !== 'undefined' ? globalThis : this );
