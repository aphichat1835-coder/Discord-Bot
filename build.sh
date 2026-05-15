#!/usr/bin/env bash

# Render deployment script
set -e

echo "🚀 Building Discord Bot for Render..."

# Update package dependencies
echo "📦 Installing dependencies..."
npm install --production

echo "✅ Build complete!"
echo "ℹ️  Starting bot with: npm start"
