# Getting Your Devin Session Token

The bridge needs a Devin/Cognition session token to access GLM-5.2 and other models.

## Option 1: Windsurf IDE (Recommended)

1. **Install Windsurf IDE**
   - Download from [codeium.com/windsurf](https://codeium.com/windsurf)
   - Available for macOS, Linux, Windows

2. **Login with your Devin account**
   - Open Windsurf IDE
   - Sign in with your Devin/Cognition credentials
   - Wait for the IDE to fully load

3. **Find your credentials file**
   ```bash
   cat ~/.codeium/windsurf/credentials.toml
   ```
   
   You should see:
   ```toml
   windsurf_api_key = "your-session-token-here"
   ```

4. **Verify the token works**
   ```bash
   # Start windsurf-server
   node ~/.devin-9router-bridge/windsurf-server.js 8083
   
   # Test it
   curl http://127.0.0.1:8083/v1/models
   ```
   
   You should see a list of available models including `glm-5-2`.

## Option 2: Manual Token Entry

If you have a Devin session token but no Windsurf IDE:

1. Create the credentials file:
   ```bash
   mkdir -p ~/.codeium/windsurf
   cat > ~/.codeium/windsurf/credentials.toml << 'EOF'
   windsurf_api_key = "your-devin-session-token"
   EOF
   ```

2. Get your token from:
   - Devin CLI: Run `devin auth status` or check `~/.devin/credentials`
   - Devin web app: Check browser cookies/localStorage after logging in

## Troubleshooting

### "No windsurf_api_key found"
- Make sure Windsurf IDE is installed and you've logged in at least once
- Check the file path: `~/.codeium/windsurf/credentials.toml`
- On macOS, the path might be: `/Users/YOUR_USERNAME/.codeium/windsurf/credentials.toml`

### "401 Unauthorized" when calling the API
- Your session token may have expired
- Re-login to Windsurf IDE to refresh the token
- Restart windsurf-server after refreshing: `pkill -f windsurf-server && node ~/.devin-9router-bridge/windsurf-server.js 8083`

### "402 Payment Required"
- You've hit the monthly limit on your Devin account
- Wait for the limit to reset, or upgrade your Devin plan
