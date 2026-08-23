#include "../collab_pcb_reference_policy.h"

#include <cassert>
#include <map>
#include <set>
#include <string>
#include <vector>

int main()
{
    using pcbjam_collab::PcbReferenceOwnerKind;
    using pcbjam_collab::PcbReferenceSpec;

    const std::string group = "aaaaaaaa-0000-0000-0000-000000000001";
    const std::string generator = "bbbbbbbb-0000-0000-0000-000000000002";
    const std::string memberA = "cccccccc-0000-0000-0000-000000000003";
    const std::string memberB = "dddddddd-0000-0000-0000-000000000004";
    const std::string memberC = "eeeeeeee-0000-0000-0000-000000000005";
    std::string       error;
    PcbReferenceSpec  spec;

    std::string normalized;
    assert( pcbjam_collab::normalizePcbReferenceUuid(
            "AAAAAAAA-0000-0000-0000-000000000001", normalized ) );
    assert( normalized == group );
    assert( !pcbjam_collab::normalizePcbReferenceUuid( "not-a-uuid", normalized ) );

    const std::string groupBlob =
            "(kicad_pcb (version 20260206) (generator \"pcbnew\")"
            " (group \"named\" (uuid \"AAAAAAAA-0000-0000-0000-000000000001\")"
            " (members \"cccccccc-0000-0000-0000-000000000003\""
            " \"dddddddd-0000-0000-0000-000000000004\")))";
    assert( pcbjam_collab::extractPcbReferenceSpec( groupBlob, group, spec, error ) );
    assert( spec.kind == PcbReferenceOwnerKind::Group );
    assert( spec.owner == group );
    assert( ( spec.members == std::vector<std::string>{ memberA, memberB } ) );

    // Legacy generator UUIDs may be unquoted, and arbitrary nested property lists must not be
    // mistaken for direct `(members ...)` content.
    const std::string generatorBlob =
            "(kicad_pcb (version 20231212) (generator pcbnew)"
            " (generated (id bbbbbbbb-0000-0000-0000-000000000002)"
            " (type tuning_pattern) (base_line (pts (xy 1 2) (xy 3 4)))"
            " (members eeeeeeee-0000-0000-0000-000000000005)))";
    assert( pcbjam_collab::extractPcbReferenceSpec(
            generatorBlob, generator, spec, error ) );
    assert( spec.kind == PcbReferenceOwnerKind::Generator );
    assert( ( spec.members == std::vector<std::string>{ memberC } ) );

    const std::string duplicateMember =
            "(group \"\" (uuid \"" + group + "\") (members \"" + memberA
            + "\" \"" + memberA + "\"))";
    assert( !pcbjam_collab::extractPcbReferenceSpec(
            duplicateMember, group, spec, error ) );
    assert( error.find( "repeats member" ) != std::string::npos );

    PcbReferenceSpec emptyGroup{ PcbReferenceOwnerKind::Group, group, {} };
    PcbReferenceSpec emptyGenerator{ PcbReferenceOwnerKind::Generator, generator, {} };
    assert( !pcbjam_collab::validatePcbReferencePersistability(
            emptyGroup, false, error ) );
    assert( pcbjam_collab::validatePcbReferencePersistability(
            emptyGenerator, false, error ) );
    assert( !pcbjam_collab::validatePcbReferencePersistability(
            emptyGenerator, true, error ) );

    const std::set<std::string> roots{ group, generator, memberA, memberB, memberC };
    const std::map<std::string, std::vector<std::string>> validReferences{
        { group, { memberA, generator } },
        { generator, { memberB, memberC } },
    };
    assert( pcbjam_collab::validatePcbReferenceClosure( roots, validReferences, error ) );

    // Replacing a native pointer does not alter the UUID graph: the same validated relation can
    // be rebound to the replacement root after every commit entry has been staged.
    const std::set<std::string> rootsAfterMemberReplacement = roots;
    assert( pcbjam_collab::validatePcbReferenceClosure(
            rootsAfterMemberReplacement, validReferences, error ) );

    auto missing = validReferences;
    missing[group].push_back( "ffffffff-0000-0000-0000-000000000006" );
    assert( !pcbjam_collab::validatePcbReferenceClosure( roots, missing, error ) );
    assert( error.find( "absent" ) != std::string::npos );

    auto multipleOwners = validReferences;
    multipleOwners[generator].push_back( memberA );
    assert( !pcbjam_collab::validatePcbReferenceClosure( roots, multipleOwners, error ) );
    assert( error.find( "multiple owners" ) != std::string::npos );

    const std::map<std::string, std::vector<std::string>> cycle{
        { group, { generator } },
        { generator, { group } },
    };
    assert( !pcbjam_collab::validatePcbReferenceClosure( roots, cycle, error ) );
    assert( error.find( "cycle" ) != std::string::npos );

    return 0;
}
