/*
 * WASM implementation of kiplatform/sysinfo.h
 * Provides limited system info available in browser environment
 */

#include <kiplatform/sysinfo.h>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

namespace KIPLATFORM
{

class SYSINFO_WASM : public SYSINFO_BASE
{
public:
    bool GetGPUInfo( std::vector<GPU_INFO>& aGpuInfos ) override
    {
#ifdef __EMSCRIPTEN__
        GPU_INFO info;

        // Try to get WebGL renderer info
        char* renderer = (char*)EM_ASM_PTR({
            try {
                var canvas = document.createElement('canvas');
                var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    var debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
                    if (debugInfo) {
                        var renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                        var len = lengthBytesUTF8(renderer) + 1;
                        var buf = _malloc(len);
                        if (!buf) {
                            return 0; // F-3: never write through a failed alloc; 0 = fallback name
                        }
                        stringToUTF8(renderer, buf, len);
                        return buf;
                    }
                }
                return 0;
            } catch(e) {
                return 0;
            }
        });

        if (renderer) {
            info.Name = renderer;
            free(renderer);
        } else {
            info.Name = "WebGL Renderer";
        }

        info.MemorySize = 0;  // Not available in browser
        info.DriverVersion = "WebGL";
        info.Manufacturer = "Browser";

        aGpuInfos.push_back(info);
        return true;
#else
        return false;
#endif
    }

    bool GetCPUInfo( std::vector<CPU_INFO>& aCpuInfos ) override
    {
#ifdef __EMSCRIPTEN__
        CPU_INFO info;

        // Get hardware concurrency (number of logical processors)
        int cores = EM_ASM_INT({
            return navigator.hardwareConcurrency || 1;
        });

        info.Name = "WebAssembly CPU";
        info.Manufacturer = "Browser";
        info.NumberCores = cores;
        info.NumberLogical = cores;

        aCpuInfos.push_back(info);
        return true;
#else
        return false;
#endif
    }

    bool GetMemoryInfo( MEMORY_INFO& aMemoryInfo ) override
    {
#ifdef __EMSCRIPTEN__
        // Try to get memory info from performance.memory (Chrome only)
        // or estimate from WASM heap
        long long heapSize = EM_ASM_INT({
            if (performance && performance.memory) {
                return performance.memory.jsHeapSizeLimit || 0;
            }
            // Return WASM memory size as fallback
            return HEAPU8.length;
        });

        aMemoryInfo.Usage = 0;
        aMemoryInfo.TotalPhysical = heapSize;
        aMemoryInfo.FreePhysical = heapSize / 2;  // Estimate
        aMemoryInfo.TotalPaging = 0;
        aMemoryInfo.FreePaging = 0;
        aMemoryInfo.TotalVirtual = heapSize;
        aMemoryInfo.FreeVirtual = heapSize / 2;

        return true;
#else
        return false;
#endif
    }
};

} // namespace KIPLATFORM

// Global instance for the WASM sysinfo implementation
static KIPLATFORM::SYSINFO_WASM s_sysInfoWasm;

// Provide access to the sysinfo implementation
KIPLATFORM::SYSINFO_BASE* GetSysInfo()
{
    return &s_sysInfoWasm;
}
