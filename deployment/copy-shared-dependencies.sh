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

# Copy subtitle-utils.js to each function that needs it
for func in "${subtitle_functions[@]}"; do
    if [ -d "$source_dir/$func" ]; then
        echo "Copying subtitle-utils.js to $func"
        cp "$source_dir/shared/subtitle-utils.js" "$source_dir/$func/"
    else
        echo "Warning: Directory $source_dir/$func not found"
    fi
done

echo "------------------------------------------------------------------------------"
echo "[Copy Shared Dependencies] Complete"
echo "------------------------------------------------------------------------------"