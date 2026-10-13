#pragma once
#include <climits>
#include <string>
#include <nlohmann/json.hpp>
// Plugin edit receipts (plugins 0023): a plugin's create / change / delete of items runs as one
// local KiCad commit on the apply queue; JS polls its result. One edit at a time. Host-only:
// guest plugins never see these handles.
namespace pcbjam_plugin_edit
{
// Bounds the editor adapter enforces too; native code never trusts the caller for them.
constexpr size_t MAX_ITEMS = 2000;
constexpr size_t MAX_ITEM_BYTES = 512 * 1024;
constexpr size_t MAX_TOTAL_BYTES = 4 * 1024 * 1024;
constexpr size_t MAX_LABEL = 200;

struct Operation
{
    int id = 0;
    bool pending = false;
    bool started = false;
    std::string result = R"({"status":"expired"})";
};
inline Operation& current() { static Operation value; return value; }
inline int begin()
{
    if( current().pending || current().id == INT_MAX ) return 0;
    const int id = current().id + 1;
    current() = Operation{};
    current().id = id;
    current().pending = true;
    current().result = R"({"status":"queued"})";
    return id;
}
// The queued body calls this first: false once the edit was cancelled (or superseded).
inline bool start( int id )
{
    if( current().id != id || !current().pending ) return false;
    current().started = true;
    return true;
}
inline void finish( int id, const nlohmann::json& aResult )
{
    if( current().id != id ) return;
    current().pending = false;
    current().result = aResult.dump();
}
inline std::string status( int id )
{
    return current().id == id ? current().result : std::string( R"({"status":"expired"})" );
}
// Withdraw an edit that has not started; one that already runs finishes normally.
inline bool cancel( int id )
{
    if( current().id != id || !current().pending || current().started ) return false;
    finish( id, nlohmann::json{ { "status", "cancelled" } } );
    return true;
}
// {label, upsert:[{sexpr}], remove:[uuid], libSymbols?:[sexpr]} within the bounds above.
inline bool wellFormed( const nlohmann::json& aReq )
{
    if( !aReq.is_object() || !aReq.value( "label", nlohmann::json() ).is_string()
        || aReq["label"].get<std::string>().empty() || aReq["label"].get<std::string>().size() > MAX_LABEL )
        return false;
    const nlohmann::json upsert = aReq.value( "upsert", nlohmann::json::array() );
    const nlohmann::json remove = aReq.value( "remove", nlohmann::json::array() );
    const nlohmann::json libs = aReq.value( "libSymbols", nlohmann::json::array() );
    if( !upsert.is_array() || !remove.is_array() || !libs.is_array() || upsert.size() + remove.size() == 0
        || upsert.size() + remove.size() > MAX_ITEMS || libs.size() > 64 )
        return false;
    size_t total = 0;
    for( const nlohmann::json& u : upsert )
    {
        if( !u.is_object() || !u.value( "sexpr", nlohmann::json() ).is_string() ) return false;
        const size_t bytes = u["sexpr"].get_ref<const std::string&>().size();
        if( bytes == 0 || bytes > MAX_ITEM_BYTES ) return false;
        total += bytes;
    }
    for( const nlohmann::json& l : libs )
    {
        if( !l.is_string() || l.get_ref<const std::string&>().size() > MAX_ITEM_BYTES ) return false;
        total += l.get_ref<const std::string&>().size();
    }
    for( const nlohmann::json& r : remove )
        if( !r.is_string() || r.get_ref<const std::string&>().size() != 36 ) return false;
    return total <= MAX_TOTAL_BYTES;
}
inline nlohmann::json error( const char* aCode, nlohmann::json aIds = nlohmann::json::array() )
{
    return nlohmann::json{ { "status", "error" }, { "code", aCode }, { "ids", std::move( aIds ) } };
}
inline int version() { return 1; }
}
