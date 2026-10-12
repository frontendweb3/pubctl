#!/usr/bin/env bash
# ==============================================================================
# pubctl installer script
# Installs standalone binary without requiring Node.js, Bun, or npm.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/officialrajdeepsingh/pubctl/main/install.sh | bash
#
# Environment variables:
#   PUBCTL_REPO         GitHub repository (default: officialrajdeepsingh/pubctl)
#   PUBCTL_VERSION      Release tag (default: latest)
#   PUBCTL_INSTALL_DIR  Target installation directory (default: /usr/local/bin)
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

REPO="${PUBCTL_REPO:-officialrajdeepsingh/pubctl}"
VERSION="${PUBCTL_VERSION:-latest}"
INSTALL_DIR="${PUBCTL_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="pubctl"

printf "${BOLD}${BLUE}==> Installing pubctl (Zero-config Ghost Docker Orchestrator)...${NC}\n"

# 1. Detect Operating System
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "${OS}" in
  linux*)  OS_TARGET="linux" ;;
  darwin*) OS_TARGET="darwin" ;;
  *)
    printf "${RED}Error: Unsupported operating system '${OS}'. Only Linux and macOS are supported.${NC}\n" >&2
    exit 1
    ;;
esac

# 2. Detect CPU Architecture
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)   ARCH_TARGET="x64" ;;
  arm64|aarch64)  ARCH_TARGET="arm64" ;;
  *)
    printf "${RED}Error: Unsupported architecture '${ARCH}'. Supported: x86_64, arm64.${NC}\n" >&2
    exit 1
    ;;
esac

ASSET_NAME="pubctl-${OS_TARGET}-${ARCH_TARGET}"
printf "    Detected platform: ${BOLD}${OS_TARGET}-${ARCH_TARGET}${NC}\n"

# 3. Build Download URL
if [ "${VERSION}" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
else
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"
fi

# 4. Download Binary to Temporary Location
TMP_DIR="$(mktemp -d)"
TMP_FILE="${TMP_DIR}/pubctl"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

printf "    Downloading from: ${DOWNLOAD_URL}...\n"
if command -v curl >/dev/null 2>&1; then
  if ! curl -fSL# "${DOWNLOAD_URL}" -o "${TMP_FILE}"; then
    printf "${RED}Error: Failed to download binary. Please ensure release exists at ${DOWNLOAD_URL}${NC}\n" >&2
    exit 1
  fi
elif command -v wget >/dev/null 2>&1; then
  if ! wget -q --show-progress "${DOWNLOAD_URL}" -O "${TMP_FILE}"; then
    printf "${RED}Error: Failed to download binary via wget.${NC}\n" >&2
    exit 1
  fi
else
  printf "${RED}Error: Neither curl nor wget was found on your system.${NC}\n" >&2
  exit 1
fi

chmod +x "${TMP_FILE}"

# 5. Determine Destination Directory & Permissions
USE_SUDO=""
if [ ! -w "${INSTALL_DIR}" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      USE_SUDO="sudo"
    else
      # Fallback to user-local directory if sudo not available
      INSTALL_DIR="${HOME}/.local/bin"
      mkdir -p "${INSTALL_DIR}"
    fi
  fi
fi

TARGET_BIN="${INSTALL_DIR}/${BINARY_NAME}"
printf "    Installing binary to: ${BOLD}${TARGET_BIN}${NC}\n"

if [ -n "${USE_SUDO}" ]; then
  ${USE_SUDO} mkdir -p "${INSTALL_DIR}"
  ${USE_SUDO} mv "${TMP_FILE}" "${TARGET_BIN}"
  ${USE_SUDO} chmod +x "${TARGET_BIN}"
else
  mkdir -p "${INSTALL_DIR}"
  mv "${TMP_FILE}" "${TARGET_BIN}"
  chmod +x "${TARGET_BIN}"
fi

# 6. Verify Installation
if command -v pubctl >/dev/null 2>&1; then
  printf "${GREEN}✓ Successfully installed pubctl!${NC}\n"
else
  printf "${GREEN}✓ Installed to ${TARGET_BIN}${NC}\n"
  if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    printf "${YELLOW}! Warning: ${INSTALL_DIR} is not in your PATH.${NC}\n"
    printf "  Add it by running: export PATH=\"${INSTALL_DIR}:\$PATH\"\n"
  fi
fi

# 7. Check Docker Availability
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
