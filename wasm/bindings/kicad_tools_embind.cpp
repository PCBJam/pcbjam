// kicad_tools' "embind" object — deliberately embind-free, mirroring
// sym_convert_embind.cpp / pcb_convert_embind.cpp (ysync 0009 size research).
//
// Both dieted kifaces reference exactly ONE editor-embind symbol:
// kicadCollabBeforeSave / kicadCollabOnSave (eeschema files-io.cpp / pcbnew
// files.cpp save paths —
// neither executes headless, and both TUs are pruned from the diets anyway).
// This no-op hook satisfies any remaining reference without rooting the
// editor surface.
extern "C" bool kicadCollabBeforeSave() { return true; }
extern "C" void kicadCollabAfterSave() {}
extern "C" void kicadCollabOnSave( const char* /* aPath */ ) {}
