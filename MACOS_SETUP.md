# macOS Setup Guide

This guide explains what needs to be done to build and run the ProSystem Print Agent on macOS.

## Prerequisites

1. **macOS Development Environment**
   - macOS 10.13 or later
   - Xcode Command Line Tools installed (`xcode-select --install`)
   - Node.js and npm installed

2. **Code Signing Certificate** (for distribution)
   - Apple Developer account (for App Store or notarized distribution)
   - Or use ad-hoc signing for local testing

## Required Files

### 1. Icon File (.icns)

The app requires a macOS icon file at `build/icon.icns`. This file is referenced in `package.json` but needs to be created from your existing icon files.

**To create icon.icns:**

**Option A: Using iconutil (macOS built-in)**
```bash
# Create an iconset directory structure
mkdir build/icon.iconset

# Copy your icon.png to various sizes (you can use sips or ImageMagick)
# Required sizes: 16x16, 32x32, 128x128, 256x256, 512x512, 1024x1024
# And @2x versions: 32x32, 64x64, 256x256, 512x512, 1024x1024, 2048x2048

# Example using sips (if you have icon.png):
sips -z 16 16 build/icon.png --out build/icon.iconset/icon_16x16.png
sips -z 32 32 build/icon.png --out build/icon.iconset/icon_16x16@2x.png
sips -z 32 32 build/icon.png --out build/icon.iconset/icon_32x32.png
sips -z 64 64 build/icon.png --out build/icon.iconset/icon_32x32@2x.png
sips -z 128 128 build/icon.png --out build/icon.iconset/icon_128x128.png
sips -z 256 256 build/icon.png --out build/icon.iconset/icon_128x128@2x.png
sips -z 256 256 build/icon.png --out build/icon.iconset/icon_256x256.png
sips -z 512 512 build/icon.png --out build/icon.iconset/icon_256x256@2x.png
sips -z 512 512 build/icon.png --out build/icon.iconset/icon_512x512.png
sips -z 1024 1024 build/icon.png --out build/icon.iconset/icon_512x512@2x.png

# Convert iconset to icns
iconutil -c icns build/icon.iconset -o build/icon.icns

# Clean up
rm -rf build/icon.iconset
```

**Option B: Using online tools**
- Use tools like [CloudConvert](https://cloudconvert.com/png-to-icns) or [IconKitchen](https://icon.kitchen/)
- Upload your `build/icon.png` or `build/ProSystem-icon.png`
- Download the `.icns` file and place it in `build/icon.icns`

**Option C: Using electron-builder**
If you have a high-resolution PNG (1024x1024), electron-builder can generate the .icns automatically during build, but it's better to provide it explicitly.

## Code Changes Made

The following changes have been made to support macOS:

### 1. **Cross-Platform Process Management** (`main.js` & `printer-api.js`)
   - Windows: Uses `netstat` and `taskkill`
   - macOS/Linux: Uses `lsof` and `kill`
   - All process killing functions now work on macOS

### 2. **Platform-Specific Icon Paths** (`main.js`)
   - macOS: Uses `.icns` files
   - Windows: Uses `.ico` files
   - Linux: Uses `.png` files
   - Icons are automatically selected based on platform

### 3. **Auto-Launch Configuration** (`main.js`)
   - macOS: Uses app bundle path (required for Launch Agents)
   - Windows/Linux: Uses executable path
   - Properly configured for macOS Launch Agents

### 4. **Build Configuration** (`package.json`)
   - Added macOS-specific build settings
   - Configured entitlements for network access and JIT compilation
   - Set up hardened runtime (required for notarization)

### 5. **Entitlements File** (`build/entitlements.mac.plist`)
   - Created with necessary permissions for:
     - Network client/server access (for API)
     - JIT compilation (for Electron)
     - Library validation disabled (for native modules)

## Building for macOS

### Development Build (Local Testing)

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build DMG (without code signing)
npm run dist -- --mac
```

### Production Build (Code Signed)

For distribution, you'll need to configure code signing:

1. **Set environment variables:**
```bash
export APPLE_ID="your-apple-id@example.com"
export APPLE_ID_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

2. **Or configure in package.json:**
```json
"mac": {
  "identity": "Developer ID Application: Your Name (TEAM_ID)",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist"
}
```

3. **Build and notarize:**
```bash
npm run dist -- --mac
```

## Testing on macOS

1. **Install the app:**
   - Open the generated `.dmg` file
   - Drag the app to Applications folder
   - Open it from Applications (may need to allow in Security & Privacy)

2. **Verify functionality:**
   - Check that the tray icon appears in the menu bar
   - Verify the API is accessible at `http://127.0.0.1:21321`
   - Test printing functionality
   - Verify auto-launch on login

## Common Issues

### Issue: "App is damaged" or Gatekeeper blocks the app
**Solution:** 
- Right-click the app → Open (first time only)
- Or: `xattr -cr /Applications/ProSystem\ Print\ Agent.app`
- For distribution: Code sign and notarize the app

### Issue: Tray icon doesn't appear
**Solution:**
- Check that `build/icon.png` exists (used for tray icon on macOS)
- Verify the icon file is valid PNG format
- Check Console.app for errors

### Issue: Port already in use
**Solution:**
- The app now automatically handles this on macOS using `lsof` and `kill`
- If issues persist, manually kill: `lsof -ti:21321 | xargs kill -9`

### Issue: Auto-launch doesn't work
**Solution:**
- Check System Preferences → Users & Groups → Login Items
- The app should appear as "ProSystem Print Agent"
- Verify the app bundle path is correct

## Directory Structure

When building for macOS, the app will be packaged as:
```
ProSystem Print Agent.app/
├── Contents/
│   ├── MacOS/
│   │   └── ProSystem Print Agent (executable)
│   ├── Resources/
│   │   └── app.asar (your app code)
│   └── Info.plist (app metadata)
```

## Additional Notes

- **Network Permissions:** The app requires network access for the API (ports 21321, 21322)
- **Printer Access:** macOS may prompt for printer access permissions
- **Auto-Updates:** GitHub Releases work the same way on macOS
- **Different Directory:** As mentioned, macOS apps are in `/Applications/` instead of Windows `Program Files`

## Next Steps

1. Create the `build/icon.icns` file (see instructions above)
2. Test the app on macOS
3. Configure code signing if distributing
4. Build and test the DMG installer
5. Set up notarization for distribution outside the App Store

