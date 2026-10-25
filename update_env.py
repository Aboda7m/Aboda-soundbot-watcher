import os
import re

def parse_env_file(filepath):
    """Parses an env file into a dictionary of {key: value}."""
    data = {}
    if not os.path.exists(filepath):
        return data
    
    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                # Allow comments in private file, but check if they contain an assignment
                pass
            
            # Match pattern: optional #, optional whitespace, KEY, =, value
            match = re.match(r'^(?:#\s*)?([A-Z0-9_]+)\s*=\s*(.*)$', stripped)
            if match:
                key, val = match.groups()
                data[key] = val.strip()
    return data

def update_env(example_path='.env.example', private_path='.env.private', output_path='.env'):
    if not os.path.exists(example_path):
        print(f"❌ Error: Template file '{example_path}' not found!")
        return

    if not os.path.exists(private_path):
        print(f"⚠️ Warning: Private secrets file '{private_path}' not found. Copying template as-is.")
        private_data = {}
    else:
        private_data = parse_env_file(private_path)
    
    success_count = 0
    uncommented_count = 0
    missing_keys = []
    output_lines = []
    
    print("🔄 Processing .env update...")
    
    with open(example_path, 'r', encoding='utf-8') as f:
        for line in f:
            # Match lines that define a variable (active or commented out with #)
            match = re.match(r'^(\s*)(#?\s*)([A-Z0-9_]+)\s*=\s*(.*)$', line)
            
            if match:
                indent, hash_prefix, key, default_val = match.groups()
                is_commented = bool(hash_prefix.strip())
                
                if key in private_data:
                    private_val = private_data[key]
                    # Write active line with the private value (uncommented if it was commented)
                    output_lines.append(f"{key}={private_val}\n")
                    if is_commented:
                        uncommented_count += 1
                        print(f"  [🔓 UNCOMMENTED & POPULATED] {key}")
                    else:
                        success_count += 1
                        print(f"  [✅ POPULATED] {key}")
                else:
                    # Key not found in private file, keep the example line as-is
                    output_lines.append(line)
                    missing_keys.append(key)
            else:
                # Keep comments, spacing, and blank lines from example template
                output_lines.append(line)
                
    # Write out the new .env file
    with open(output_path, 'w', encoding='utf-8') as f:
        f.writelines(output_lines)
        
    print("\n--- 📊 Update Summary ---")
    print(f"  Successfully mapped: {success_count}")
    print(f"  Uncommented & mapped: {uncommented_count}")
    print(f"  Missing in .env.private: {len(missing_keys)}")
    
    if missing_keys:
        print("\n⚠️ **Keys not found in .env.private (kept example defaults/placeholders):**")
        for k in sorted(set(missing_keys)):
            print(f"   - {k}")
        print("\n👉 Please check the list above and copy/fill them manually into your .env or .env.private if needed.")
    else:
        print("\n🎉 All keys successfully accounted for!")

if __name__ == '__main__':
    update_env()