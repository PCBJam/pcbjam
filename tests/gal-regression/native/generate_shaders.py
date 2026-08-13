#!/usr/bin/env python3
"""
Generate C++ shader headers from KiCad GLSL files.

This script converts GLSL shader files to C++ headers compatible with
KiCad's BUILTIN_SHADERS namespace.
"""

import os
import sys

def convert_shader_to_cpp(source_path, var_name):
    """Convert a shader file to C++ header content."""
    with open(source_path, 'rb') as f:
        data = f.read()

    # Convert to hex array
    hex_values = ', '.join(f'0x{b:02x}' for b in data)
    hex_values += ', 0x00'  # Null terminate

    array_size = len(data)

    header_content = f"""// Auto-generated shader header from {os.path.basename(source_path)}
#ifndef {var_name.upper()}_H
#define {var_name.upper()}_H

#include <string>

namespace KIGFX {{
namespace BUILTIN_SHADERS {{
    extern std::string {var_name};
}}
}}

#endif // {var_name.upper()}_H
"""

    cpp_content = f"""// Auto-generated from {os.path.basename(source_path)}
#include <string>
#include "{var_name}.h"

namespace KIGFX {{
namespace BUILTIN_SHADERS {{

static unsigned char {var_name}_bytes[] = {{ {hex_values} }};

std::string {var_name} = std::string(reinterpret_cast<char const*>({var_name}_bytes), {array_size});

}}
}}
"""

    return header_content, cpp_content

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    kicad_root = os.path.abspath(os.path.join(script_dir, '..', '..', '..', 'kicad'))
    shaders_dir = os.path.join(kicad_root, 'common', 'gal', 'shaders')

    output_dir = os.path.join(script_dir, 'generated')
    os.makedirs(output_dir, exist_ok=True)

    shaders = [
        ('kicad_frag.glsl', 'glsl_kicad_frag'),
        ('kicad_vert.glsl', 'glsl_kicad_vert'),
        ('smaa_base.glsl', 'glsl_smaa_base'),
        ('smaa_pass_1_frag_color.glsl', 'glsl_smaa_pass_1_frag_color'),
        ('smaa_pass_1_frag_luma.glsl', 'glsl_smaa_pass_1_frag_luma'),
        ('smaa_pass_1_vert.glsl', 'glsl_smaa_pass_1_vert'),
        ('smaa_pass_2_frag.glsl', 'glsl_smaa_pass_2_frag'),
        ('smaa_pass_2_vert.glsl', 'glsl_smaa_pass_2_vert'),
        ('smaa_pass_3_frag.glsl', 'glsl_smaa_pass_3_frag'),
        ('smaa_pass_3_vert.glsl', 'glsl_smaa_pass_3_vert'),
        ('xor_diff_frag.glsl', 'glsl_xor_diff_frag'),
        ('xor_diff_vert.glsl', 'glsl_xor_diff_vert'),
    ]

    generated_cpp_files = []

    for shader_file, var_name in shaders:
        source_path = os.path.join(shaders_dir, shader_file)

        if not os.path.exists(source_path):
            print(f"Warning: {source_path} not found, skipping")
            continue

        header_content, cpp_content = convert_shader_to_cpp(source_path, var_name)

        header_path = os.path.join(output_dir, f'{var_name}.h')
        cpp_path = os.path.join(output_dir, f'{var_name}.cpp')

        with open(header_path, 'w') as f:
            f.write(header_content)

        with open(cpp_path, 'w') as f:
            f.write(cpp_content)

        generated_cpp_files.append(cpp_path)
        print(f"Generated {var_name}.h and {var_name}.cpp")

    print(f"\nGenerated {len(generated_cpp_files)} shader files in {output_dir}")

if __name__ == '__main__':
    main()
