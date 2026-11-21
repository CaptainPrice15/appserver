#!/usr/bin/env bash
# ==============================================================================
# Stealth Chat Server - 1-Click OCI VM.Standard.E2.1.Micro Bootstrap Script
# Target Domain: stealth-chat.duckdns.org
# OS: Ubuntu 22.04 / 24.04 LTS
# ==============================================================================
set -e

echo "=================================================================="
echo " Starting Stealth Chat Server Setup for OCI VM.Standard.E2.1.Micro"
echo "=================================================================="

# Check root or sudo
if [ "$EUID" -ne 0 ]; then
  SUDO="sudo"
else
  SUDO=""
fi

# 1. 2GB Swapfile Configuration for 1GB RAM VM
echo ""
echo "--> [1/5] Checking swapfile configuration..."
SWAP_TOTAL=$(free -m | awk '/^Swap:/ {print $2}')
if [ "$SWAP_TOTAL" -lt 1024 ]; then
  echo "    Creating 2GB swapfile to protect against OOM spikes..."
  if [ ! -f /swapfile ]; then
    $SUDO fallocate -l 2G /swapfile 2>/dev/null || $SUDO dd if=/dev/zero of=/swapfile bs=1M count=2048
    $SUDO chmod 600 /swapfile
    $SUDO mkswap /swapfile
    $SUDO swapon /swapfile
    echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab
    echo "    2GB Swapfile activated successfully."
  else
    $SUDO swapon /swapfile 2>/dev/null || true
  fi
else
  echo "    Adequate swap already exists (${SWAP_TOTAL} MB)."
fi

# 2. Package Updates & Core Utilities
echo ""
echo "--> [2/5] Updating apt packages and installing core dependencies..."
$SUDO apt-get update -y
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y \
  curl wget git build-essential nginx certbot python3-certbot-nginx \
  iptables-persistent netfilter-persistent

# 3. Node.js 20 LTS & PM2
echo ""
echo "--> [3/5] Setting up Node.js 20 LTS and PM2 daemon..."
if ! command -v node > /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
  echo "    Installing Node.js 20.x from NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi

echo "    Installing PM2 and logrotate module..."
$SUDO npm install -g pm2
pm2 install pm2-logrotate 2>/dev/null || true
pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
pm2 set pm2-logrotate:retain 7 2>/dev/null || true

# 4. Host Firewall Configuration (OCI iptables & ufw)
echo ""
echo "--> [4/5] Opening host firewall for ports 80, 443, and 8080..."
# OCI Ubuntu images block ports in iptables by default
$SUDO iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
$SUDO iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
$SUDO iptables -I INPUT 6 -p tcp --dport 8080 -j ACCEPT 2>/dev/null || $SUDO iptables -I INPUT 1 -p tcp --dport 8080 -j ACCEPT
$SUDO netfilter-persistent save 2>/dev/null || true

if command -v ufw > /dev/null; then
  $SUDO ufw allow 22/tcp 2>/dev/null || true
  $SUDO ufw allow 80/tcp 2>/dev/null || true
  $SUDO ufw allow 443/tcp 2>/dev/null || true
  $SUDO ufw allow 8080/tcp 2>/dev/null || true
  $SUDO ufw --force enable 2>/dev/null || true
fi

# 5. Summary
echo ""
echo "=================================================================="
echo " OCI Host Bootstrap Completed Successfully!"
echo " Node.js: $(node -v)"
echo " npm:     v$(npm -v)"
echo " PM2:     v$(pm2 -v)"
echo " Nginx:   $(nginx -v 2>&1)"
echo "=================================================================="
