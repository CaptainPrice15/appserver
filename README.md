# Stealth Chat Real-Time Backend

Dedicated WebSocket & HTTP server for the Stealth Minigame Chat Android app.

---

## 🚀 1. Deploying to Render.com (Global 4G/5G/Wi-Fi Chat)

### Option A: Direct from GitHub (Recommended)
1. Initialize a git repository in this folder and push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for stealth chat backend"
   git remote add origin https://github.com/<your-username>/stealth-chat-server.git
   git push -u origin main
   ```
2. Log in to [Render Dashboard](https://dashboard.render.com).
3. Click **New +** -> **Web Service**.
4. Connect your GitHub repository.
5. Set the settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
6. Click **Create Web Service**.
7. Render will provide a public URL like: `https://stealth-chat-xyz.onrender.com`.
8. Your Android app WebSocket URL is:
   ```
   wss://stealth-chat-xyz.onrender.com
   ```

### Option B: Using Render Blueprint
In Render Dashboard, select **New +** -> **Blueprint**, choose your repo, and Render will automatically detect `render.yaml`.

---

## 💻 2. Running Locally (Local Wi-Fi)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Find your PC's IP address (`ipconfig` on Windows).
4. In the Android app Vault Settings, enter:
   ```
   ws://<YOUR_PC_IP>:8080
   ```

---

## 🧪 3. Testing Real-Time Messaging

Run the built-in two-phone simulation test:
```bash
node test_client.js
```
Or test against your live Render server:
```bash
$env:SERVER_URL="wss://stealth-chat-xyz.onrender.com"
node test_client.js
```
