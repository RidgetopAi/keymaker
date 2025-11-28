#!/bin/bash
# Keymaker Bootstrap Script
# Sets up all infrastructure from scratch

set -e

echo "==================================="
echo "Keymaker Infrastructure Bootstrap"
echo "==================================="
echo ""

# Check Ollama
echo "1. Checking Ollama..."
if ! command -v ollama &> /dev/null; then
    echo "   ❌ Ollama not installed"
    echo "   Install: curl -fsSL https://ollama.ai/install.sh | sh"
    exit 1
fi
echo "   ✅ Ollama installed"

# Check if Ollama is running
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "   ⚠️  Ollama not running. Starting..."
    ollama serve &
    sleep 3
fi
echo "   ✅ Ollama running"

# Pull models
echo ""
echo "2. Pulling models (this may take a few minutes)..."
ollama pull llama3.2:3b
ollama pull nomic-embed-text
echo "   ✅ Models ready"

# Create database
echo ""
echo "3. Setting up database..."
if psql -h localhost -p 5432 -c "SELECT 1 FROM pg_database WHERE datname='keymaker_dev'" 2>/dev/null | grep -q "1"; then
    echo "   ⚠️  keymaker_dev already exists"
else
    createdb keymaker_dev
    echo "   ✅ Created keymaker_dev"
fi

# Load schemas
echo "   Loading schemas..."
psql keymaker_dev < schema/entity_registry.sql
psql keymaker_dev < schema/contradiction_tracking.sql
psql keymaker_dev < schema/keymaker_main.sql
psql keymaker_dev < schema/migrations/001_embedding_768.sql
echo "   ✅ Schemas loaded"

# Install npm dependencies
echo ""
echo "4. Installing npm dependencies..."
npm install
echo "   ✅ Dependencies installed"

echo ""
echo "==================================="
echo "✅ Bootstrap complete!"
echo "==================================="
echo ""
echo "Next: Run validation experiment"
echo "  npm run validate"
echo ""
