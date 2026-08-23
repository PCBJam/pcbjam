/*
 * Pure pcbnew group/generator reference policy.
 *
 * KiCad's board parser resolves `(members ...)` only after every item in the
 * parsed BOARD is present.  The collaboration wire intentionally parses one
 * root at a time, so an isolated PCB_GROUP/PCB_GENERATOR would otherwise lose
 * every reference before the native batch can be assembled.  This header
 * captures the UUID relation directly from the accepted wire text and validates
 * the complete post-batch graph without depending on KiCad, wx, or Emscripten.
 */

#pragma once

#include <cctype>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace pcbjam_collab
{

enum class PcbReferenceOwnerKind
{
    Group,
    Generator,
};

struct PcbReferenceSpec
{
    PcbReferenceOwnerKind kind = PcbReferenceOwnerKind::Group;
    std::string           owner;
    std::vector<std::string> members;
};

/**
 * KiCad omits every empty PCB_GROUP and an empty tuning-pattern generator
 * from its board writer. Reject those roots before native mutation so an ACK
 * can never describe an item that disappears at the next save boundary.
 */
inline bool validatePcbReferencePersistability( const PcbReferenceSpec& aSpec,
                                                bool aIsTuningGenerator,
                                                std::string& aError )
{
    if( aSpec.members.empty()
        && ( aSpec.kind == PcbReferenceOwnerKind::Group || aIsTuningGenerator ) )
    {
        aError = "PCB reference owner is not persistable without members: " + aSpec.owner;
        return false;
    }

    aError.clear();
    return true;
}

namespace pcb_reference_detail
{

enum class TokenKind
{
    Open,
    Close,
    Value,
};

struct Token
{
    TokenKind   kind;
    std::string value;
};

inline bool tokenize( const std::string& aText, std::vector<Token>& aTokens,
                      std::string& aError )
{
    for( size_t i = 0; i < aText.size(); )
    {
        const unsigned char ch = static_cast<unsigned char>( aText[i] );

        if( std::isspace( ch ) )
        {
            ++i;
            continue;
        }

        if( ch == '(' )
        {
            aTokens.push_back( { TokenKind::Open, {} } );
            ++i;
            continue;
        }

        if( ch == ')' )
        {
            aTokens.push_back( { TokenKind::Close, {} } );
            ++i;
            continue;
        }

        if( ch == '"' )
        {
            std::string value;
            bool        closed = false;
            ++i;

            while( i < aText.size() )
            {
                char current = aText[i++];

                if( current == '"' )
                {
                    closed = true;
                    break;
                }

                if( current == '\\' )
                {
                    if( i == aText.size() )
                    {
                        aError = "unterminated escape in PCB reference blob";
                        return false;
                    }

                    current = aText[i++];
                }

                value.push_back( current );
            }

            if( !closed )
            {
                aError = "unterminated string in PCB reference blob";
                return false;
            }

            aTokens.push_back( { TokenKind::Value, std::move( value ) } );
            continue;
        }

        const size_t start = i;

        while( i < aText.size() )
        {
            const unsigned char current = static_cast<unsigned char>( aText[i] );

            if( std::isspace( current ) || current == '(' || current == ')' )
                break;

            ++i;
        }

        if( i == start )
        {
            aError = "invalid token in PCB reference blob";
            return false;
        }

        aTokens.push_back( { TokenKind::Value, aText.substr( start, i - start ) } );
    }

    return true;
}

inline bool normalizeUuid( const std::string& aInput, std::string& aOutput )
{
    if( aInput.size() != 36 )
        return false;

    aOutput.clear();
    aOutput.reserve( aInput.size() );

    for( size_t i = 0; i < aInput.size(); ++i )
    {
        const unsigned char ch = static_cast<unsigned char>( aInput[i] );
        const bool hyphen = i == 8 || i == 13 || i == 18 || i == 23;

        if( hyphen )
        {
            if( ch != '-' )
                return false;

            aOutput.push_back( '-' );
        }
        else
        {
            if( !std::isxdigit( ch ) )
                return false;

            aOutput.push_back( static_cast<char>( std::tolower( ch ) ) );
        }
    }

    return true;
}

struct Frame
{
    std::string              head;
    std::vector<std::string> values;
    bool                     hasNestedList = false;

    bool                     invalid = false;
    bool                     ownerSeen = false;
    bool                     membersSeen = false;
    std::string              owner;
    std::vector<std::string> members;

    bool candidate() const { return head == "group" || head == "generated"; }
};

inline void foldCandidateChild( Frame& aCandidate, const Frame& aChild )
{
    if( aChild.head == "uuid" || aChild.head == "id" )
    {
        if( aCandidate.ownerSeen || aChild.hasNestedList || aChild.values.size() != 1 )
        {
            aCandidate.invalid = true;
            return;
        }

        aCandidate.ownerSeen = true;
        aCandidate.owner = aChild.values.front();
    }
    else if( aChild.head == "members" )
    {
        if( aCandidate.membersSeen || aChild.hasNestedList )
        {
            aCandidate.invalid = true;
            return;
        }

        aCandidate.membersSeen = true;
        aCandidate.members = aChild.values;
    }
}

} // namespace pcb_reference_detail

/**
 * Validate and canonicalize a collaboration UUID before it participates in a
 * graph comparison.  Removals arrive outside a native parser, so their spelling
 * must be normalized before comparing them with parser-produced UUIDs.
 */
inline bool normalizePcbReferenceUuid( const std::string& aInput,
                                       std::string& aOutput )
{
    return pcb_reference_detail::normalizeUuid( aInput, aOutput );
}

/**
 * Extract one group/generator's authoritative UUID member list from its wire
 * blob. Both current quoted UUIDs and legacy unquoted UUIDs are accepted.
 */
inline bool extractPcbReferenceSpec( const std::string& aText,
                                     const std::string& aExpectedOwner,
                                     PcbReferenceSpec& aSpec,
                                     std::string& aError )
{
    using namespace pcb_reference_detail;

    std::string expected;

    if( !normalizeUuid( aExpectedOwner, expected ) )
    {
        aError = "parsed PCB reference owner has an invalid UUID";
        return false;
    }

    std::vector<Token> tokens;

    if( !tokenize( aText, tokens, aError ) )
        return false;

    std::vector<Frame> stack;
    bool               found = false;

    for( const Token& token : tokens )
    {
        if( token.kind == TokenKind::Open )
        {
            if( stack.size() >= 256 )
            {
                aError = "PCB reference blob nesting is too deep";
                return false;
            }

            if( !stack.empty() )
                stack.back().hasNestedList = true;

            stack.emplace_back();
            continue;
        }

        if( token.kind == TokenKind::Value )
        {
            if( stack.empty() )
            {
                aError = "value outside a list in PCB reference blob";
                return false;
            }

            Frame& frame = stack.back();

            if( frame.head.empty() )
                frame.head = token.value;
            else
                frame.values.push_back( token.value );

            continue;
        }

        if( stack.empty() )
        {
            aError = "unbalanced close parenthesis in PCB reference blob";
            return false;
        }

        Frame closed = std::move( stack.back() );
        stack.pop_back();

        if( closed.head.empty() )
        {
            aError = "empty list in PCB reference blob";
            return false;
        }

        if( !stack.empty() && stack.back().candidate() )
            foldCandidateChild( stack.back(), closed );

        if( !closed.candidate() )
            continue;

        std::string owner;

        if( !closed.ownerSeen || !normalizeUuid( closed.owner, owner ) || owner != expected )
            continue;

        if( found )
        {
            aError = "PCB reference blob contains the owner more than once: " + expected;
            return false;
        }

        if( closed.invalid || !closed.membersSeen )
        {
            aError = "PCB reference owner has malformed or missing members: " + expected;
            return false;
        }

        std::set<std::string> unique;
        std::vector<std::string> members;

        for( const std::string& rawMember : closed.members )
        {
            std::string member;

            if( !normalizeUuid( rawMember, member ) )
            {
                aError = "PCB reference owner has an invalid member UUID: " + expected;
                return false;
            }

            if( !unique.insert( member ).second )
            {
                aError = "PCB reference owner repeats member " + member + ": " + expected;
                return false;
            }

            members.push_back( std::move( member ) );
        }

        aSpec.kind = closed.head == "generated" ? PcbReferenceOwnerKind::Generator
                                                  : PcbReferenceOwnerKind::Group;
        aSpec.owner = expected;
        aSpec.members = std::move( members );
        found = true;
    }

    if( !stack.empty() )
    {
        aError = "unclosed list in PCB reference blob";
        return false;
    }

    if( !found )
    {
        aError = "PCB reference blob does not contain parsed owner: " + expected;
        return false;
    }

    aError.clear();
    return true;
}

/**
 * Validate the board-level group/generator relation over the complete
 * post-batch root UUID set. The relation must be closed, single-parented and
 * acyclic; EDA_GROUP::AddItem cannot represent anything weaker losslessly.
 */
inline bool validatePcbReferenceClosure(
        const std::set<std::string>& aPostRootIds,
        const std::map<std::string, std::vector<std::string>>& aReferences,
        std::string& aError )
{
    std::map<std::string, std::string> parentByMember;
    std::map<std::string, size_t>      indegree;
    std::map<std::string, std::vector<std::string>> ownerEdges;

    for( const auto& [owner, members] : aReferences )
    {
        if( !aPostRootIds.count( owner ) )
        {
            aError = "PCB reference owner is absent after the batch: " + owner;
            return false;
        }

        indegree.try_emplace( owner, 0 );
        std::set<std::string> localMembers;

        for( const std::string& member : members )
        {
            if( !localMembers.insert( member ).second )
            {
                aError = "PCB reference owner repeats member " + member + ": " + owner;
                return false;
            }

            if( member == owner )
            {
                aError = "PCB reference owner contains itself: " + owner;
                return false;
            }

            if( !aPostRootIds.count( member ) )
            {
                aError = "PCB reference member is absent after the batch: " + member;
                return false;
            }

            auto [parentIt, inserted] = parentByMember.emplace( member, owner );

            if( !inserted && parentIt->second != owner )
            {
                aError = "PCB reference member has multiple owners: " + member;
                return false;
            }

            if( aReferences.count( member ) )
            {
                ownerEdges[owner].push_back( member );
                ++indegree[member];
            }
        }
    }

    std::vector<std::string> ready;

    for( const auto& [owner, degree] : indegree )
    {
        if( degree == 0 )
            ready.push_back( owner );
    }

    size_t visited = 0;

    while( !ready.empty() )
    {
        std::string owner = std::move( ready.back() );
        ready.pop_back();
        ++visited;

        for( const std::string& child : ownerEdges[owner] )
        {
            if( --indegree[child] == 0 )
                ready.push_back( child );
        }
    }

    if( visited != indegree.size() )
    {
        aError = "PCB group/generator membership contains a cycle";
        return false;
    }

    aError.clear();
    return true;
}

} // namespace pcbjam_collab
