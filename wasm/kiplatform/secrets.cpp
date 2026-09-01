/*
 * WASM implementation of kiplatform/secrets.h
 * Uses browser localStorage for basic secret storage
 * Note: localStorage is NOT secure for sensitive secrets, but provides
 * the same API for KiCad functionality that expects secret storage
 */

#include <kiplatform/secrets.h>
#include <wx/string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace KIPLATFORM
{
namespace SECRETS
{

bool StoreSecret( const wxString& aService, const wxString& aKey, const wxString& aSecret )
{
#ifdef __EMSCRIPTEN__
    int result = EM_ASM_INT({
        try {
            var service = UTF8ToString($0);
            var key = UTF8ToString($1);
            var secret = UTF8ToString($2);
            var storageKey = 'kicad_secret_' + service + '_' + key;
            localStorage.setItem(storageKey, secret);
            return 1;
        } catch(e) {
            console.warn('Failed to store secret:', e);
            return 0;
        }
    }, aService.utf8_str().data(), aKey.utf8_str().data(), aSecret.utf8_str().data());
    return result == 1;
#else
    return false;
#endif
}

bool GetSecret( const wxString& aService, const wxString& aKey, wxString& aSecret )
{
#ifdef __EMSCRIPTEN__
    char* result = (char*)EM_ASM_PTR({
        try {
            var service = UTF8ToString($0);
            var key = UTF8ToString($1);
            var storageKey = 'kicad_secret_' + service + '_' + key;
            var secret = localStorage.getItem(storageKey);
            if (secret === null) {
                return 0;
            }
            var len = lengthBytesUTF8(secret) + 1;
            var buf = _malloc(len);
            if (!buf) {
                return 0; // F-3: never write through a failed alloc; 0 = "no secret"
            }
            stringToUTF8(secret, buf, len);
            return buf;
        } catch(e) {
            console.warn('Failed to get secret:', e);
            return 0;
        }
    }, aService.utf8_str().data(), aKey.utf8_str().data());

    if (result) {
        aSecret = wxString::FromUTF8(result);
        free(result);
        return true;
    }
    return false;
#else
    return false;
#endif
}

bool DeleteSecret( const wxString& aService, const wxString& aKey )
{
#ifdef __EMSCRIPTEN__
    int result = EM_ASM_INT({
        try {
            var service = UTF8ToString($0);
            var key = UTF8ToString($1);
            var storageKey = 'kicad_secret_' + service + '_' + key;
            localStorage.removeItem(storageKey);
            return 1;
        } catch(e) {
            console.warn('Failed to delete secret:', e);
            return 0;
        }
    }, aService.utf8_str().data(), aKey.utf8_str().data());
    return result == 1;
#else
    return false;
#endif
}

} // namespace SECRETS
} // namespace KIPLATFORM
