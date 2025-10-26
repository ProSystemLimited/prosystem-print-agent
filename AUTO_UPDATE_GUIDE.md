# Auto-Update Setup Guide for ProSystem Print Agent

## Overview

The ProSystem Print Agent now supports **automatic updates** using `electron-updater`. Users with the app installed will automatically receive updates without manual downloads.

## How It Works

1. **App checks for updates** on startup and every 6 hours
2. **User sees notification** in system tray: "Update to v1.1.0"
3. **User clicks** to download update
4. **After download**, user sees: "Restart to install v1.1.0"
5. **User clicks restart** - app installs update and restarts
6. **Update complete!** User now has latest version

## Initial Setup (One-Time)

### 1. Create GitHub Repository

```bash
# Create a new GitHub repository named "prosystem-print-agent"
# Can be private or public
```

### 2. Update package.json Configuration

Replace `YOUR_USERNAME` in [package.json](./package.json) with your actual GitHub username:

**Line 9:**
```json
"url": "https://github.com/YOUR_USERNAME/prosystem-print-agent.git"
```

**Lines 42-43:**
```json
"owner": "YOUR_USERNAME",
"repo": "prosystem-print-agent"
```

### 3. Create GitHub Personal Access Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Name: `electron-builder-publish`
4. Select scopes: `repo` (full control of private repositories)
5. Click "Generate token"
6. **Copy the token** (you won't see it again!)

### 4. Set Environment Variable

**Windows (Command Prompt):**
```cmd
setx GH_TOKEN "your_github_token_here"
```

**Windows (PowerShell):**
```powershell
$env:GH_TOKEN = "your_github_token_here"
```

**Restart your terminal** after setting the token.

## Publishing Updates Workflow

### Step 1: Update Version Number

Edit [package.json](./package.json) and increment the version:

```json
{
  "version": "1.0.1"  // Change from 1.0.0 to 1.0.1
}
```

**Version numbering:**
- `1.0.0` → `1.0.1` - Bug fixes
- `1.0.0` → `1.1.0` - New features
- `1.0.0` → `2.0.0` - Breaking changes

### Step 2: Build and Publish

```bash
cd electron-print-agent

# Install dependencies (if needed)
npm install

# Build and publish to GitHub Releases
npm run dist -- --publish always
```

This will:
1. Build the installer for Windows
2. Create a GitHub Release with version tag (e.g., `v1.0.1`)
3. Upload installer files to GitHub Releases
4. Upload update metadata files (`latest.yml`)

### Step 3: Verify Release

1. Go to your GitHub repository
2. Click "Releases" tab
3. You should see a new release (e.g., `v1.0.1`)
4. Files should include:
   - `ProSystem-Print-Agent-Setup-1.0.1.exe` (installer)
   - `ProSystem-Print-Agent-Setup-1.0.1.exe.blockmap`
   - `latest.yml` (update metadata)

## User Experience

### First Install

Users download and install `ProSystem-Print-Agent-Setup-1.0.0.exe` normally.

### When Update is Available

1. **App checks for updates** (on startup or every 6 hours)
2. **Tray icon shows**: "Update to v1.0.1"
3. **User clicks** → Downloads update in background
4. **Download complete** → "Restart to install v1.0.1"
5. **User clicks restart** → App updates and restarts automatically

### If User Ignores Update

- Update option stays in tray menu
- User can update whenever convenient
- Update installs on next app restart (via `autoInstallOnAppQuit`)

## Configuration Details

### Auto-Update Behavior

From [main.js](./main.js):

```javascript
autoUpdater.autoDownload = false; // Ask user before downloading
autoUpdater.autoInstallOnAppQuit = true; // Install when app closes
```

**Why this approach?**
- ✅ User has control - no forced updates
- ✅ Non-intrusive - updates in background
- ✅ Reliable - installs on app restart
- ✅ No disruption - user chooses when to restart

### Update Check Frequency

```javascript
// Check on startup
autoUpdater.checkForUpdates();

// Check every 6 hours
setInterval(() => autoUpdater.checkForUpdates(), 6 * 60 * 60 * 1000);
```

You can adjust the interval in [main.js](./main.js#L161).

## Development vs Production

### Development Mode

```bash
npm start
```

- ❌ Auto-updates **disabled**
- Updates only work in packaged apps (`app.isPackaged`)

### Production Mode

```bash
npm run dist
# Then install the generated .exe
```

- ✅ Auto-updates **enabled**
- Checks GitHub for updates

## Troubleshooting

### Issue: "No updates available" but new version exists

**Cause:** Version in package.json not incremented

**Solution:** Ensure version in package.json is higher than installed version:
```json
// If users have 1.0.0, new version must be 1.0.1 or higher
"version": "1.0.1"
```

### Issue: "Error checking for updates"

**Cause 1:** GitHub repository configuration incorrect

**Solution:** Verify in [package.json](./package.json):
- Repository URL matches your GitHub repo
- `owner` and `repo` in `publish` section are correct

**Cause 2:** GitHub Release not published

**Solution:** Ensure `npm run dist -- --publish always` succeeded and release is visible on GitHub.

### Issue: Update downloads but won't install

**Cause:** Windows code signing issues

**Solution:** For production apps, you should sign your code. For now, users may need to:
1. Allow Windows SmartScreen
2. Click "More info" → "Run anyway"

### Issue: Build fails with "Cannot publish"

**Cause:** GitHub token not set or invalid

**Solution:**
```bash
# Verify token is set
echo %GH_TOKEN%  # Windows CMD
echo $env:GH_TOKEN  # Windows PowerShell

# If empty, set it again
setx GH_TOKEN "your_token_here"
# Restart terminal
```

## Code Signing (Optional but Recommended)

For production apps, code signing prevents Windows security warnings.

### Without Code Signing

Users see: "Windows protected your PC"
- They must click "More info" → "Run anyway"
- Updates work but require this extra step

### With Code Signing

1. Purchase code signing certificate (e.g., from DigiCert, Sectigo)
2. Add to package.json:
   ```json
   "win": {
     "certificateFile": "path/to/certificate.pfx",
     "certificatePassword": "password"
   }
   ```
3. Users get seamless updates with no warnings

## Alternative: Self-Hosted Updates

If you don't want to use GitHub Releases, you can host updates on your own server:

**package.json:**
```json
"publish": {
  "provider": "generic",
  "url": "https://your-server.com/updates"
}
```

Your server must host:
- `latest.yml` - Update metadata
- `.exe` installer files
- `.blockmap` files

## Summary

✅ **Setup Complete:**
- electron-updater installed
- Auto-update logic in main.js
- GitHub Releases configured
- Tray menu shows update options

✅ **Publishing Process:**
1. Increment version in package.json
2. Run `npm run dist -- --publish always`
3. Users automatically get update notification

✅ **User Experience:**
- Non-intrusive updates
- User controls when to install
- Seamless update process

## Quick Reference

```bash
# Check current version
cat package.json | grep version

# Update version
# Edit package.json manually

# Build and publish
npm run dist -- --publish always

# Build without publishing (testing)
npm run dist

# Check if GH_TOKEN is set
echo %GH_TOKEN%  # Windows CMD
```

---

**Need help?** Check the [electron-updater documentation](https://www.electron.build/auto-update)
