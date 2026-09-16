#pragma once
#include <functional>
#include <string>
#include <nlohmann/json.hpp>

// Host-only operation receipts. Guest plugins never receive these native handles.
namespace pcbjam_plugin_placement
{
struct Operation
{
    int id = 0;
    std::string status = "expired";
    std::string error;
    bool cancelled = false;
    std::function<void()> cancelNative;
};
inline Operation& current() { static Operation value; return value; }
inline bool pending() { return current().status == "queued" || current().status == "placing"; }
inline int begin()
{
    if( pending() || current().id == 2147483647 ) return 0;
    const int id = current().id + 1;
    current() = Operation{};
    current().id = id;
    current().status = "queued";
    return id;
}
inline bool allowed( int id ) { return current().id == id && pending() && !current().cancelled; }
inline void finish( int id, const std::string& status, const std::string& error = "" )
{
    if( current().id != id ) return;
    current().status = status;
    current().error = error;
    current().cancelNative = {};
}
inline std::string status( int id )
{
    if( current().id != id ) return R"({"status":"expired"})";
    return nlohmann::json{ { "status", current().status }, { "error", current().error } }.dump();
}
inline bool cancel( int id )
{
    if( current().id != id || !pending() ) return false;
    current().cancelled = true; // The native commit guard observes this immediately.
    if( current().status == "queued" ) finish( id, "cancelled" );
    else if( current().cancelNative )
    {
        // Completion may clear the stored callback while it is executing.
        auto cancelNative = current().cancelNative;
        cancelNative();
    }
    return true;
}
inline int version() { return 1; }
}
