#pragma once
#include <climits>
#include <string>
#include <nlohmann/json.hpp>
// Update PCB from Schematic receipts (ai-chat 0003 step 5b): the AI chat's run of KiCad's own
// update is queued on the event loop; JS polls its result. One run at a time.
namespace pcbjam_update_pcb
{
inline int version() { return 1; }

struct Operation
{
    int id = 0;
    bool pending = false;
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
} // namespace pcbjam_update_pcb
