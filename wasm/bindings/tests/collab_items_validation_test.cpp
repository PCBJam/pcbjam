#include "../collab_items_validation.h"

#include <cassert>
#include <string>
#include <vector>

using nlohmann::json;

int main()
{
    std::string error;

    const json valid = {
        { "added", json::array( { { { "sexpr", "(segment (uuid a))" },
                                      { "parent", nullptr } } } ) },
        { "changed", json::array() },
        { "removed", json::array( { "b" } ) },
        { "_pcbjam", { { "requestId", "r1" }, { "ownerGeneration", "o1" } } },
    };

    assert( pcbjam_collab::validateItemsWireShape( valid, error ) );
    assert( pcbjam_collab::validateRootLiftedItemsWire( valid, error ) );

    json wrongCategory = valid;
    wrongCategory["removed"] = "b";
    assert( !pcbjam_collab::validateItemsWireShape( wrongCategory, error ) );

    json blankBlob = valid;
    blankBlob["added"][0]["sexpr"] = "  \n\t";
    assert( !pcbjam_collab::validateItemsWireShape( blankBlob, error ) );

    json wrongParent = valid;
    wrongParent["added"][0]["parent"] = 42;
    assert( !pcbjam_collab::validateItemsWireShape( wrongParent, error ) );

    json danglingChild = valid;
    danglingChild["added"][0]["parent"] = "parent-uuid";
    assert( pcbjam_collab::validateItemsWireShape( danglingChild, error ) );
    assert( !pcbjam_collab::validateRootLiftedItemsWire( danglingChild, error ) );

    json incompleteTicket = valid;
    incompleteTicket["_pcbjam"].erase( "requestId" );
    assert( !pcbjam_collab::validateItemsWireShape( incompleteTicket, error ) );

    assert( pcbjam_collab::validateItemsBatchIds( { "removed" }, { "added" },
                                                  { "changed" }, error ) );
    assert( !pcbjam_collab::validateItemsBatchIds( { "same" }, { "same" }, {}, error ) );
    assert( !pcbjam_collab::validateItemsBatchIds( {}, { "same", "same" }, {}, error ) );
    assert( !pcbjam_collab::validateItemsBatchIds( {}, { "same" }, { "same" }, error ) );
    assert( !pcbjam_collab::validateItemsBatchIds( { "" }, {}, {}, error ) );

    return 0;
}
