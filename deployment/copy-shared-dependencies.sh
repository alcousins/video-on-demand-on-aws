#!/bin/bash
#
# This script copies shared dependencies to Lambda functions that need them
# This ensures that when Lambda functions are packaged individually, they have
# access to the shared utilities they import.
#

set -e

# Get reference for source directory
source_dir="$(dirname "$0")/../source"

echo "------------------------------------------------------------------------------"
echo "[Copy Shared Dependencies] Copying shared utilities to Lambda functions"
echo "------------------------------------------------------------------------------"

# List of Lambda functions that need subtitle-utils.js
subtitle_functions=(
    "subtitle-config"
    "transcription"
    "translation-coordinator"
    "translation-worker"
    "webvtt-generator"
)

# Copy shared files to each function that needs them
for func in "${subtitle_functions[@]}"; do
    if [ -d "$source_dir/$func" ]; then
        echo "Copying shared files to $func"
        cp "$source_dir/shared/subtitle-utils.js" "$source_dir/$func/"
        cp "$source_dir/shared/subtitle-error-handler.js" "$source_dir/$func/"
        cp "$source_dir/shared/s3-storage-utils.js" "$source_dir/$func/"
        
        # Copy additional shared files based on function needs
        case $func in
            "transcription")
                cp "$source_dir/shared/dynamo-subtitle-client.js" "$source_dir/$func/"
                cp "$source_dir/shared/performance-optimizer.js" "$source_dir/$func/"
                cp "$source_dir/shared/notification-integration.js" "$source_dir/$func/"
                ;;
            "translation-coordinator")
                cp "$source_dir/shared/subtitle-types.js" "$source_dir/$func/"
                cp "$source_dir/shared/performance-optimizer.js" "$source_dir/$func/"
                cp "$source_dir/shared/notification-integration.js" "$source_dir/$func/"
                ;;
            "translation-worker")
                cp "$source_dir/shared/subtitle-types.js" "$source_dir/$func/"
                ;;
            "webvtt-generator")
                cp "$source_dir/shared/subtitle-types.js" "$source_dir/$func/"
                cp "$source_dir/shared/s3-storage-utils.js" "$source_dir/$func/"
                ;;
        esac
    else
        echo "Warning: Directory $source_dir/$func not found"
    fi
done

# Also copy shared files to encode function
if [ -d "$source_dir/encode" ]; then
    echo "Copying shared files to encode"
    cp "$source_dir/shared/subtitle-utils.js" "$source_dir/encode/"
    cp "$source_dir/shared/s3-storage-utils.js" "$source_dir/encode/"
fi

echo "------------------------------------------------------------------------------"
echo "[Copy Shared Dependencies] Complete"
echo "------------------------------------------------------------------------------"