/**
 * DEMO ONLY — Cloudflare Worker variant
 * This worker is a development/demo stub. For production use,
 * use the Node.js server (server.ts) which includes:
 * - Authentication middleware
 * - Origin-restricted CORS
 * - HTML-encoded error outputs
 *
 * To use the full server: see README.md Quick Start section.
 *
 * If you still want to deploy this worker, you'll need:
 * 1. A Canva app at https://www.canva.com/developers/
 * 2. CANVA_CLIENT_ID, CANVA_CLIENT_SECRET in Cloudflare environment
 * 3. CANVA_REDIRECT_URI set to your Worker URL + /auth/callback
 * 4. A KV namespace: `wrangler kv:namespace create CANVA_TOKENS`
 * 5. The namespace binding added to wrangler.toml
 */

import { z } from "zod";

// Minimal widget HTML for search results (simplified from canva-search-designs.html)
const SEARCH_WIDGET_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Canva Design Search</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(to bottom, #F5F5F7 0%, #E8E8EA 100%); padding: 24px; min-height: 100vh; }
    .container { max-width: 1400px; margin: 0 auto; }
    .header { margin-bottom: 32px; border-bottom: 2px solid #00C4CC; padding-bottom: 20px; }
    .title { font-size: 32px; font-weight: 900; color: #00C4CC; margin-bottom: 8px; }
    .subtitle { font-size: 15px; color: #6B6B6B; font-weight: 500; }
    .oauth-notice { background: #FFF3CD; border: 2px solid #FFC107; border-radius: 12px; padding: 20px; margin-bottom: 24px; }
    .oauth-notice h3 { color: #856404; margin-bottom: 10px; }
    .oauth-notice p { color: #856404; line-height: 1.6; }
    .oauth-notice code { background: rgba(0,0,0,0.1); padding: 2px 6px; border-radius: 4px; }
    .designs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 24px; }
    .design-card { background: white; border-radius: 24px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: all 0.3s; cursor: pointer; }
    .design-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(0,196,204,0.2); }
    .design-thumbnail { width: 100%; height: 180px; object-fit: cover; background: linear-gradient(135deg, #E8E8EA 0%, #F5F5F7 100%); }
    .design-info { padding: 20px; }
    .design-title { font-weight: 700; font-size: 18px; color: #1A1A1A; margin-bottom: 12px; }
    .design-meta { font-size: 13px; color: #6B6B6B; margin-bottom: 12px; }
    .design-actions { display: flex; gap: 8px; }
    .btn { flex: 1; padding: 10px 16px; border: 2px solid #00C4CC; background: transparent; color: #00C4CC; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; text-decoration: none; text-align: center; }
    .btn:hover { background: #00C4CC; color: white; }
    .btn-primary { background: #00C4CC; color: white; }
    .btn-primary:hover { background: #00A8B0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 class="title" id="search-query">Canva Designs</h1>
      <p class="subtitle" id="search-stats"></p>
    </div>
    <div id="oauth-notice"></div>
    <div id="designs-grid" class="designs-grid"></div>
  </div>
  <script>
    const data = window.__WIDGET_PROPS__ || {};
    document.getElementById('search-query').textContent = data.query || 'Recent Designs';
    document.getElementById('search-stats').textContent = (data.designs?.length || 0) + ' designs found';
    
    if (data.requiresAuth) {
      const notice = document.getElementById('oauth-notice');
      const wrapper = document.createElement('div');
      wrapper.className = 'oauth-notice';
      const heading = document.createElement('h3');
      heading.textContent = 'OAuth Setup Required';
      const para = document.createElement('p');
      para.textContent = 'To access your Canva designs, set up OAuth authentication. Set ';
      const code1 = document.createElement('code');
      code1.textContent = 'CANVA_CLIENT_ID';
      const mid = document.createTextNode(', ');
      const code2 = document.createElement('code');
      code2.textContent = 'CANVA_CLIENT_SECRET';
      const end = document.createTextNode(', and configure a KV namespace in your Cloudflare Worker. Visit the ');
      const link = document.createElement('a');
      link.href = 'https://www.canva.com/developers/';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Canva Developers';
      const tail = document.createTextNode(' portal to create your app.');
      para.appendChild(code1);
      para.appendChild(mid);
      para.appendChild(code2);
      para.appendChild(end);
      para.appendChild(link);
      para.appendChild(tail);
      wrapper.appendChild(heading);
      wrapper.appendChild(para);
      notice.appendChild(wrapper);
    }
    
    const grid = document.getElementById('designs-grid');
    (data.designs || []).forEach(design => {
      const card = document.createElement('div');
      card.className = 'design-card';

      const img = document.createElement('img');
      img.src = design.thumbnail || '';
      img.className = 'design-thumbnail';
      img.onerror = function() {
        (this as HTMLImageElement).style.background = 'linear-gradient(135deg, #00C4CC 0%, #7B61FF 100%)';
        (this as HTMLImageElement).src = '';
      };

      const info = document.createElement('div');
      info.className = 'design-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'design-title';
      titleEl.textContent = design.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'design-meta';
      metaEl.textContent = 'Type: ' + (design.type || 'Design');

      const actions = document.createElement('div');
      actions.className = 'design-actions';

      const link = document.createElement('a');
      link.href = design.url;
      link.target = '_blank';
      link.className = 'btn btn-primary';
      link.textContent = 'Open in Canva';

      actions.appendChild(link);
      info.appendChild(titleEl);
      info.appendChild(metaEl);
      info.appendChild(actions);
      card.appendChild(img);
      card.appendChild(info);
      grid.appendChild(card);
    });
  </script>
</body>
</html>`;

const WIDGETS = {
  search: {
    id: "search-designs",
    title: "Canva Design Search",
    templateUri: "ui://widget/canva-search-designs.html",
    invoking: "Searching Canva",
    invoked: "Search complete",
  },
};

function widgetMeta(widget: typeof WIDGETS.search) {
  return {
    "openai/outputTemplate": widget.templateUri,
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
  };
}

// Zod parsers
const searchDesignsInputParser = z.object({
  query: z.string().optional(),
  sortBy: z.enum(["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"]).optional(),
  ownershipFilter: z.enum(["any", "owned", "shared"]).optional(),
});

// Tool definitions
const tools = [
  {
    name: WIDGETS.search.id,
    description: "Search for Canva designs. Find designs by title or content, filter by ownership, and sort results. Requires OAuth authentication to access your Canva account.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for design title or content",
        },
        sortBy: {
          type: "string",
          enum: ["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"],
          description: "Sort order for results",
        },
        ownershipFilter: {
          type: "string",
          enum: ["any", "owned", "shared"],
          description: "Filter by ownership (default: any)",
        },
      },
      additionalProperties: false,
    },
    _meta: widgetMeta(WIDGETS.search),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
];

// Mock designs for when OAuth is not configured
function getMockDesigns(query?: string) {
  return [
    {
      id: "mock-1",
      title: query ? `Design matching "${query}"` : "Presentation Template",
      type: "Presentation",
      thumbnail: "https://marketplace-assets.canva.com/MAB0I2bVjBo/0/0/900w/canva-purple-modern-presentation-template-MAB0I2bVjBo.jpg",
      url: "https://www.canva.com/",
    },
    {
      id: "mock-2",
      title: "Social Media Post",
      type: "Instagram Post",
      thumbnail: "https://marketplace-assets.canva.com/MADauCyvIZ8/0/0/900w/canva-pink-modern-instagram-post-MADauCyvIZ8.jpg",
      url: "https://www.canva.com/",
    },
    {
      id: "mock-3",
      title: "Marketing Flyer",
      type: "Flyer",
      thumbnail: "https://marketplace-assets.canva.com/MAD5mKTk_5Y/0/0/900w/canva-blue-modern-business-flyer-MAD5mKTk_5Y.jpg",
      url: "https://www.canva.com/",
    },
  ];
}

// Helper to check if OAuth is configured
function isOAuthConfigured(env: Env): boolean {
  return !!(env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET && env.CANVA_TOKENS);
}

// Helper to search Canva designs (requires OAuth token)
async function searchCanvaDesigns(
  env: Env,
  accessToken: string,
  params: {
    query?: string;
    sortBy?: string;
    ownershipFilter?: string;
  }
) {
  try {
    const searchParams = new URLSearchParams();
    if (params.query) searchParams.append("query", params.query);
    if (params.sortBy) searchParams.append("sort_by", params.sortBy);
    if (params.ownershipFilter) searchParams.append("ownership_filter", params.ownershipFilter);

    const response = await fetch(
      `https://api.canva.com/rest/v1/designs?${searchParams}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.warn(`[worker.ts] --> Canva API error: ${response.status}`);
      return null;
    }

    const data: any = await response.json();
    return data.items || [];
  } catch (error) {
    console.error("[worker.ts] --> Error searching Canva:", error);
    return null;
  }
}

interface Env {
  CANVA_CLIENT_ID: string;
  CANVA_CLIENT_SECRET: string;
  CANVA_REDIRECT_URI: string;
  CANVA_TOKENS: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // Widget HTML serving
    if (url.pathname.startsWith("/ui/widget/")) {
      const templatePath = url.pathname.replace("/ui/widget/", "");
      
      if (templatePath === "canva-search-designs.html") {
        return new Response(SEARCH_WIDGET_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      return new Response("Widget not found", { status: 404 });
    }

    // OAuth authorization endpoint
    if (url.pathname === "/auth/authorize" && request.method === "GET") {
      if (!isOAuthConfigured(env)) {
        return Response.json({
          error: "OAuth not configured. Set CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, and create CANVA_TOKENS KV namespace.",
        }, { status: 500 });
      }

      const state = crypto.randomUUID();

      // Store pending state in KV so we can validate it in the callback (expires in 10 min)
      await env.CANVA_TOKENS.put(
        `pending_state:${state}`,
        JSON.stringify({ createdAt: Date.now() }),
        { expirationTtl: 600 }
      );

      const authUrl = new URL("https://www.canva.com/api/oauth/authorize");
      authUrl.searchParams.set("client_id", env.CANVA_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", env.CANVA_REDIRECT_URI);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "design:read design:content:read folder:read");
      authUrl.searchParams.set("state", state);

      return Response.redirect(authUrl.toString(), 302);
    }

    // OAuth callback endpoint
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !state || !isOAuthConfigured(env)) {
        return new Response("OAuth not configured or missing code/state", { status: 400 });
      }

      // Validate state against stored pending states (CSRF protection)
      const pendingStateKey = `pending_state:${state}`;
      const pendingState = await env.CANVA_TOKENS.get(pendingStateKey);
      if (!pendingState) {
        return new Response("Invalid or expired state parameter", { status: 400 });
      }
      // Consume the pending state immediately
      await env.CANVA_TOKENS.delete(pendingStateKey);

      try {
        // Exchange code for token
        const tokenResponse = await fetch("https://api.canva.com/rest/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: env.CANVA_CLIENT_ID,
            client_secret: env.CANVA_CLIENT_SECRET,
            redirect_uri: env.CANVA_REDIRECT_URI,
          }),
        });

        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed: ${tokenResponse.status}`);
        }

        const tokens: any = await tokenResponse.json();

        // Store tokens in KV (use state as session ID)
        await env.CANVA_TOKENS.put(
          `session:${state}`,
          JSON.stringify({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
          }),
          { expirationTtl: 3600 * 24 * 30 } // 30 days
        );

        return new Response("OAuth successful! You can close this window.", {
          headers: { "Content-Type": "text/html" },
        });
      } catch (error) {
        console.error("[worker.ts] --> OAuth callback error:", error);
        // Do not reflect error details to the client — log only
        return new Response("OAuth error. Check server logs for details.", { status: 500 });
      }
    }

    // MCP SSE endpoint
    if (url.pathname === "/sse" && request.method === "GET") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      const sessionId = crypto.randomUUID();
      await writer.write(
        encoder.encode(
          `event: endpoint\ndata: ${JSON.stringify({ endpoint: `/message?sessionId=${sessionId}` })}\n\n`
        )
      );

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // MCP message endpoint
    if (url.pathname === "/message" && request.method === "POST") {
      const body: any = await request.json();
      const { method, params } = body;

      // List tools
      if (method === "tools/list") {
        return Response.json({
          tools: tools.map(({ _meta, ...tool }) => ({
            ...tool,
            _meta,
          })),
        });
      }

      // Call tool
      if (method === "tools/call") {
        const { name, arguments: args } = params;

        if (name === WIDGETS.search.id) {
          const parsed = searchDesignsInputParser.parse(args);
          const oauthConfigured = isOAuthConfigured(env);
          
          let designs;
          let requiresAuth = false;

          // Both branches return mock data — this worker is a demo stub.
          // Real token retrieval would go here once OAuth is wired up.
          designs = getMockDesigns(parsed.query);
          requiresAuth = true;

          return Response.json({
            content: [
              {
                type: "text",
                text: oauthConfigured
                  ? `Found ${designs.length} design${designs.length !== 1 ? "s" : ""}. (Complete OAuth flow to access real designs)`
                  : `OAuth not configured. Showing ${designs.length} mock design${designs.length !== 1 ? "s" : ""}. Set CANVA_CLIENT_ID, CANVA_CLIENT_SECRET, and create CANVA_TOKENS KV namespace to access real Canva designs.`,
              },
            ],
            structuredContent: {
              query: parsed.query,
              sortBy: parsed.sortBy,
              ownershipFilter: parsed.ownershipFilter,
              designs,
              requiresAuth,
              totalResults: designs.length,
            },
          });
        }

        return Response.json(
          { error: { code: -32601, message: "Tool not found" } },
          { status: 404 }
        );
      }

      // List resources
      if (method === "resources/list") {
        return Response.json({ resources: [] });
      }

      // List resource templates
      if (method === "resources/templates/list") {
        return Response.json({ resourceTemplates: [] });
      }

      return Response.json(
        { error: { code: -32601, message: "Method not found" } },
        { status: 404 }
      );
    }

    return new Response(
      "Canva MCP Server\n\nOAuth Setup Required:\n" +
      "1. Create a Canva app at https://www.canva.com/developers/\n" +
      "2. Set CANVA_CLIENT_ID and CANVA_CLIENT_SECRET environment variables\n" +
      "3. Create KV namespace: wrangler kv:namespace create CANVA_TOKENS\n" +
      "4. Add KV binding to wrangler.toml\n" +
      "5. Visit /auth/authorize to authenticate",
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};

