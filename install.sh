#!/usr/bin/env bash
# ==============================================================================
# pubctl installer script
# Installs pubctl CLI globally using pnpm, bun, or npm.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/frontendweb3/pubctl/main/install.sh | bash
#
# Environment variables:
#   PUBCTL_VERSION      npm version or tag (default: latest)
# ==============================================================================

set -euo pipefail

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Check if stdout is a terminal
if [ ! -t 1 ]; then
  RED=''
  GREEN=''
  BLUE=''
  YELLOW=''
  BOLD=''
  NC=''
fi

PACKAGE_NAME="pubctl"
VERSION="${PUBCTL_VERSION:-latest}"

printf "${BOLD}${BLUE}==> Installing ${PACKAGE_NAME} (Zero-config Ghost Docker Orchestrator)...${NC}\n"

# 1. Verify Node.js or Bun runtime is available
HAS_NODE=false
HAS_BUN=false

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "${NODE_MAJOR}" -ge 18 ]; then
    HAS_NODE=true
    printf "    Found Node.js: ${BOLD}$(node -v)${NC}\n"
  else
    printf "${YELLOW}! Warning: Node.js version $(node -v) is older than 18.0.0. pubctl requires Node.js 18+ or Bun.${NC}\n"
  fi
fi

if command -v bun >/dev/null 2>&1; then
  HAS_BUN=true
  printf "    Found Bun: ${BOLD}$(bun -v)${NC}\n"
fi

if [ "${HAS_NODE}" = false ] && [ "${HAS_BUN}" = false ]; then
  printf "${RED}Error: Neither Node.js (>= 18) nor Bun was found on your system.${NC}\n" >&2
  printf "Please install Node.js 18+ (https://nodejs.org) or Bun (https://bun.sh) and rerun this installer.\n" >&2
  exit 1
fi

# 2. Install globally using detected package manager
INSTALLED=false

if command -v pnpm >/dev/null 2>&1; then
  printf "    Installing globally via ${BOLD}pnpm${NC}...\n"
  if pnpm add -g "${PACKAGE_NAME}@${VERSION}"; then
    INSTALLED=true
  fi
elif command -v bun >/dev/null 2>&1; then
  printf "    Installing globally via ${BOLD}bun${NC}...\n"
  if bun add -g "${PACKAGE_NAME}@${VERSION}"; then
    INSTALLED=true
  fi
elif command -v npm >/dev/null 2>&1; then
  printf "    Installing globally via ${BOLD}npm${NC}...\n"
  if npm install -g "${PACKAGE_NAME}@${VERSION}"; then
    INSTALLED=true
  fi
fi

if [ "${INSTALLED}" = false ]; then
  printf "${RED}Error: Failed to install ${PACKAGE_NAME}. Please ensure npm, pnpm, or bun is installed and configured.${NC}\n" >&2
  exit 1
fi

# 3. Verify Installation
if command -v pubctl >/dev/null 2>&1; then
  printf "${GREEN}✓ Successfully installed pubctl!${NC}\n"
else
  printf "${YELLOW}! Warning: pubctl was installed, but 'pubctl' command was not found in your PATH.${NC}\n"
  printf "  Ensure your global bin directory is in your PATH (e.g., ~/.local/share/pnpm, ~/.bun/bin, or $(npm config get prefix)/bin).\n"
fi

# 4. Check Docker Availability
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    printf "${GREEN}✓ Docker daemon is active and accessible.${NC}\n"
  else
    printf "${YELLOW}! Docker is installed but daemon is not running or current user lacks permissions.${NC}\n"
  fi
else
  printf "${YELLOW}! Note: pubctl requires Docker to run Ghost. Please install Docker (https://docs.docker.com/engine/install/).${NC}\n"
fi

printf "\n${BOLD}${GREEN}Quickstart:${NC}\n"
printf "  pubctl init --email admin@example.com\n"
printf "  pubctl create -n myblog -d blog.example.com -e admin@example.com\n"
printf "  pubctl --help\n\n"
