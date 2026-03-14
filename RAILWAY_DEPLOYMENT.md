# Railway Deployment Guide - Canva MCP Server

## Prerequisites
- Railway CLI installed: `npm install -g @railway/cli`
- Railway account connected: `railway login`
- Canva OAuth credentials (Client ID and Secret)

## Deployment Steps

1. **Initialize Railway Project**
```bash
cd canva-mcp-server
railway init
```

2. **Set Environment Variables**
```bash
railway variables set CANVA_CLIENT_ID="<your_canva_client_id>"
railway variables set CANVA_CLIENT_SECRET="<your_canva_client_secret>"
railway variables set CANVA_REDIRECT_URI="https://canva-mcp-server-production.up.railway.app/auth/callback"
railway variables set BASE_URL="https://canva-mcp-server-production.up.railway.app"
railway variables set PORT="8001"
```

3. **Deploy**
```bash
railway up
```

4. **Get Deployment URL**
```bash
railway status
```

5. **Update Canva OAuth Settings**
   - Go to your Canva app settings
   - Update the redirect URI to match your Railway deployment URL

## Environment Variables Required
- `CANVA_CLIENT_ID` - Canva OAuth client ID
- `CANVA_CLIENT_SECRET` - Canva OAuth client secret
- `CANVA_REDIRECT_URI` - OAuth callback URL (must match Railway URL)
- `BASE_URL` - Your Railway deployment URL
- `PORT` - Port to run on (default: 8001)

## Storage Notes
- **Cloudflare Version:** Used KV namespace for token storage
- **Railway Version:** Uses in-memory storage (tokens lost on restart)
- **Production Recommendation:** Add Redis or PostgreSQL for persistent storage

## Verification
Once deployed, test the server:
```bash
curl https://your-railway-url.up.railway.app/health
```

## OAuth Flow
1. User visits `/auth/login`
2. Redirected to Canva for authorization
3. Callback to `/auth/callback`
4. Tokens stored and user can use MCP tools


