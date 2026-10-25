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
                continue
            
            # Match pattern: KEY = value
            match = re.match(r'^([A-Z0-9_]+)\s*=\s*(.*)$', stripped)
            if match:
                key, val = match.groups()
                data[key] = val.strip()
    return data

def update_env(example_path='.env.example', private_path='.env.private', output_path='.env'):
    if not os.path.exists(example_path):
        print(f"❌ Error: Template file '{example_path}' not found!")
        return

    private_data = parse_env_file(private_path)
    
    success_count = 0
    uncommented_count = 0
    missing_critical_keys = []
    output_lines = []
    
    # Define keys that you actually care about tracking if they are missing
    critical_keys = {
        'DISCORD_TOKEN', 'PUBLIC_BASE_URL', 'DISCORD_CLIENT_ID', 
        'DISCORD_CLIENT_SECRET', 'LOCAL_ACCESS_KEY', 'ACCESS_KEY'
    }
    
    print("🔄 Processing .env update...")
    
    with open(example_path, 'r', encoding='utf-8') as f:
        for line in f:
            match = re.match(r'^(\s*)(#?\s*)([A-Z0-9_]+)\s*=\s*(.*)$', line)
            
            if match:
                indent, hash_prefix, key, default_val = match.groups()
                is_commented = bool(hash_prefix.strip())
                
                if key in private_data:
                    private_val = private_data[key]
                    output_lines.append(f"{key}={private_val}\n")
                    if is_commented:
                        uncommented_count += 1
                        print(f"  [🔓 UNCOMMENTED & POPULATED] {key}")
                    else:
                        success_count += 1
                        print(f"  [✅ POPULATED] {key}")
                else:
                    output_lines.append(line)
                    if key in critical_keys:
                        missing_critical_keys.append(key)
            else:
                output_lines.append(line)
                
    # Write out the new .env file
    with open(output_path, 'w', encoding='utf-8') as f:
        f.writelines(output_lines)
        
    print("\n--- 📊 Update Summary ---")
    print(f"  Successfully mapped: {success_count}")
    print(f"  Uncommented & mapped: {uncommented_count}")
    
    if missing_critical_keys:
        print("\n⚠️ **Critical keys missing in .env.private:**")
        for k in sorted(set(missing_critical_keys)):
            print(f"   - {k}")
    else:
        print("\n🎉 All core secret keys successfully accounted for!")

if __name__ == '__main__':
    update_env()