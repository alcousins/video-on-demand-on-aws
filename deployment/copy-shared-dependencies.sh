#!/bin/bash
#
# This script copies shared dependencies to Lambda functions that need them
# This ensures that when Lambda functions are packaged individually, they have
# access to the shared utilities they import.
#
# NOTE: This script has been updated to work with minimal service-specific utilities.
# Each service now has its own minimal utility files, so we only copy files that
# don't already exist locally.
#

set -e

# Get reference for source directory
source_dir="$(dirname "$0")/../source"

echo "------------------------------------------------------------------------------"
echo "[Copy Shared Dependencies] Checking for missing dependencies in Lambda functions"
echo "------------------------------------------------------------------------------"

# List of Lambda functions that might need shared dependencies
subtitle_functions=(
    "subtitle-config"
    "transcription"
    "translation-coordinator"
    "translation-worker"
    "webvtt-generator"
    "encode"
)

# Function to copy file only if it doesn't exist locally
copy_if_missing() {
    local func_dir="$1"
    local shared_file="$2"
    local target_file="$3"
    
    if [ ! -f "$func_dir/$target_file" ]; then
        if [ -f "$source_dir/shared/$shared_file" ]; then
            echo "  Copying missing $shared_file to $func_dir"
            cp "$source_dir/shared/$shared_file" "$func_dir/$target_file"
        else
            echo "  Warning: Shared file $shared_file not found"
        fi
    else
        echo "  Local $target_file already exists, skipping copy"
    fi
}

# Check each function directory
for func in "${subtitle_functions[@]}"; do
    if [ -d "$source_dir/$func" ]; then
        echo "Checking dependencies for $func"
        
        # Only copy files that don't already exist locally
        # This preserves the minimal utility files we created
        copy_if_missing "$source_dir/$func" "subtitle-utils.js" "subtitle-utils.js"
        copy_if_missing "$source_dir/$func" "subtitle-error-handler.js" "subtitle-error-handler.js"
        copy_if_missing "$source_dir/$func" "s3-storage-utils.js" "s3-storage-utils.js"
        
        # Copy additional shared files based on function needs (only if missing)
        case $func in
            "transcription")
                copy_if_missing "$source_dir/$func" "dynamo-subtitle-client.js" "dynamo-subtitle-client.js"
                copy_if_missing "$source_dir/$func" "performance-optimizer.js" "performance-optimizer.js"
                copy_if_missing "$source_dir/$func" "notification-integration.js" "notification-integration.js"
                ;;
            "translation-coordinator")
                copy_if_missing "$source_dir/$func" "subtitle-types.js" "subtitle-types.js"
                copy_if_missing "$source_dir/$func" "performance-optimizer.js" "performance-optimizer.js"
                copy_if_missing "$source_dir/$func" "notification-integration.js" "notification-integration.js"
                ;;
            "translation-worker")
                copy_if_missing "$source_dir/$func" "subtitle-types.js" "subtitle-types.js"
                ;;
            "webvtt-generator")
                copy_if_missing "$source_dir/$func" "subtitle-types.js" "subtitle-types.js"
                ;;
        esac
    else
        echo "Warning: Directory $source_dir/$func not found"
    fi
done

echo "------------------------------------------------------------------------------"
echo "[Copy Shared Dependencies] Complete - Minimal utilities preserved"
echo "------------------------------------------------------------------------------"