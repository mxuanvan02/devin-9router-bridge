# Getting Your Devin Session Token

The bridge needs a Devin/Cognition session token to access GLM-5.2 and other models.

## Option 1: Devin CLI (Recommended)

1. **Install Devin CLI**
   - Follow the official instructions at [devin.ai](https://devin.ai)

2. **Login with your Devin account**
   ```bash
   devin auth login
   ```
   This opens a browser for OAuth login.

3. **Verify authentication**
   ```bash
   devin auth status
   ```
   Should show "Logged in" with your account details.

4. **Credentials file location**
   ```bash
   cat ~/.local/share/devin/credentials.toml
   ```

   You should see:
   ```toml
   windsurf_api_key = "devin-session-token$..."
   api_server_url = "https://server.codeium.com"
   devin_webapp_host = "app.devin.ai"
   devin_api_url = "https://api.devin.ai"
   ```

5. **Verify the token works**
   ```bash
   # Start windsurf-server
   node ~/.devin-9router-bridge/windsurf-server.js 8083

   # Test it
   curl http://127.0.0.1:8083/v1/models
   ```

   You should see a list of available models including `glm-5-2`.

## Option 2: Windsurf IDE

1. **Install Windsurf IDE**
   - Download from [codeium.com/windsurf](https://codeium.com/windsurf)
   - Available for macOS, Linux, Windows

2. **Login with your Devin account**
   - Open Windsurf IDE
   - Sign in with your Devin/Cognition credentials

3. **Find your credentials file**
   ```bash
   cat ~/.codeium/windsurf/credentials.toml
   ```

## Option 3: Manual Token Entry

If you have a Devin session token but no Devin CLI or Windsurf IDE:

```bash
mkdir -p ~/.local/share/devin
cat > ~/.local/share/devin/credentials.toml << 'EOF'
windsurf_api_key = "devin-session-token$your-token-here"
api_server_url = "https://server.codeium.com"
devin_webapp_host = "app.devin.ai"
devin_api_url = "https://api.devin.ai"
EOF
```

## Troubleshooting

### "No windsurf_api_key found"
- Run `devin auth login` to authenticate
- Check the file path: `~/.local/share/devin/credentials.toml`
- The setup script checks both `~/.local/share/devin/` and `~/.codeium/windsurf/`

### "Cascade session error" / "update your editor"
- Your session token has expired
- Run `devin auth logout` then `devin auth login` to refresh
- Restart windsurf-server after refreshing:
  ```bash
  pkill -f windsurf-server
  node ~/.devin-9router-bridge/windsurf-server.js 8083 &
  ```

### "401 Unauthorized"
- Session token is invalid or expired
- Re-authenticate with `devin auth login`

### "402 Payment Required"
- You've hit the monthly limit on your Devin account
- Wait for the limit to reset, or upgrade your Devin plan
