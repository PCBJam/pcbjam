/*
 * WASM implementation of printing.h
 * Printing is not directly supported in browser environment
 */

#include <printing.h>
#include <string>

namespace KIPLATFORM
{
namespace PRINTING
{

PRINT_RESULT PrintPDF( const std::string& aFile )
{
    // Direct printing is not supported in browser
    // User can use browser's print functionality or download the PDF
    return PRINT_RESULT::UNSUPPORTED;
}

void ResetPrintToFilePath( wxPrintData& )
{
    // Only the GTK portal backend leaves a spool path behind; nothing to reset here.
}

} // namespace PRINTING
} // namespace KIPLATFORM
