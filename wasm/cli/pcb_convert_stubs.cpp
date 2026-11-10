/*
 * pcb_convert link-order diet stubs (mirror of sym_convert_stubs.cpp).
 *
 * Listed before the kiface objects in the pcb_convert link so
 * --allow-multiple-definition resolves duplicated definitions to these
 * (first definition wins). Grows as the diet surfaces link/runtime needs;
 * function references left dangling by the CMake prune are covered by
 * -sERROR_ON_UNDEFINED_SYMBOLS=0 (they become aborting JS imports), so only
 * data/typeinfo needs and behavior overrides belong here.
 *
 * The --drc path needs no overrides — board *save* and the plot/export
 * surfaces are pruned outright, and Kiface() is deliberately left undefined so
 * a stray call aborts loudly instead of wandering on a null settings object.
 */

// ── --update-from-netlist (mcp 0006): typeinfo for pruned tools ────────────────
// BOARD_NETLIST_UPDATER owns a BOARD_COMMIT, which links board_commit.cpp, and
// BOARD_COMMIT::Push asks its TOOL_MANAGER for PCB_SELECTION_TOOL and
// ZONE_FILLER_TOOL by type (typeid): DATA symbols the tools/ prune removed,
// which (unlike functions) cannot become JS imports. Defining each class's key
// function here emits its vtable and typeinfo in this TU; the other virtuals
// stay undefined functions. Headless, no tool is ever registered, so GetTool<>
// answers null and none of these bodies runs.

#include <tools/pcb_selection_tool.h>
#include <tools/zone_filler_tool.h>
#include <zone_filler.h>

// The real PRIV is local to pcb_selection_tool.cpp (pruned): the destructor
// only needs a complete type to destroy.
class PCB_SELECTION_TOOL::PRIV
{
};

bool PCB_TOOL_BASE::Init()
{
    return true;
}

PCB_SELECTION_TOOL::~PCB_SELECTION_TOOL()
{
}

ZONE_FILLER_TOOL::~ZONE_FILLER_TOOL()
{
}
