# Stealth Chat Real-Time Backend

Dedicated WebSocket & HTTP server for the Stealth Minigame Chat Android app.

---

## ⚡ Production Deployment: Oracle Cloud Infrastructure (OCI Always Free)

Target Domain: `stealth-chat.duckdns.org`  
Target VM Shape: `VM.Standard.E2.1.Micro` (1 OCPU, 1 GB RAM, Always Free)

### Advantages over Render Free Tier:
- **Zero Sleep**: Runs 24/7 with zero spin-down delays (no 30-60s wakeups).
- **Persistent Storage**: Offline messages (`data/offline_vault.json`) and media uploads (`data/media`) are preserved across reboots.
- **Dedicated Reserved IPv4**: Free static IP with SSL/TLS (`wss://`).
- **PM2 Daemon**: Auto-restart on crash, 450MB memory threshold, and boot-time recovery.

---

### Step-by-Step Setup on OCI VM (Ubuntu 22.04 LTS)

#### 1. SSH into your OCI VM
```bash
ssh -i /path/to/your_oci_key.key ubuntu@<YOUR_OCI_PUBLIC_IP>
```

#### 2. Run the 1-Click Bootstrap Script
```bash
curl -fsSL https://raw.githubusercontent.com/CaptainPrice15/appserver/main/scripts/setup-oci.sh | bash
```
*This creates a 2GB swapfile (protecting against 1GB RAM OOM), installs Node.js 20, PM2, Nginx, Certbot, and opens firewall ports (80, 443, 8080).*

#### 3. Clone / Update Repository
```bash
git clone https://github.com/CaptainPrice15/appserver.git ~/chat-server
cd ~/chat-server
npm install
```

#### 4. Start Server with PM2 & Enable Auto-Boot
```bash
pm2 start ecosystem.config.js
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

#### 5. Configure Nginx Reverse Proxy
```bash
sudo cp ~/chat-server/nginx/stealth-chat.conf /etc/nginx/sites-available/stealth-chat.conf
sudo ln -sf /etc/nginx/sites-available/stealth-chat.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

#### 6. Issue Free Let's Encrypt SSL Certificate
```bash
sudo certbot --nginx -d stealth-chat.duckdns.org --non-interactive --agree-tos -m your-email@example.com --redirect
```

#### 7. Verify Auto-Renewal
```bash
sudo certbot renew --dry-run
```

---

## 💻 Local Wi-Fi Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start server locally:
   ```bash
   npm start
   ```
3. Test locally:
   ```bash
   npm test
   ```

---

## 🧪 Testing Real-Time Messaging

### Test against Local Server:
```bash
node test_client.js
```

### Test against Live OCI Cloud Server:
```powershell
$env:SERVER_URL="wss://stealth-chat.duckdns.org"
node test_client.js
```
