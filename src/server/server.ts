import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Local type alias for JSON Schema object — matches MCP SDK's Tool["inputSchema"]
type ToolInputSchema = Tool["inputSchema"];

// Canva OAuth configuration
const CANVA_CLIENT_ID = process.env.CANVA_CLIENT_ID || "";
const CANVA_CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || "";
const CANVA_REDIRECT_URI = process.env.CANVA_REDIRECT_URI || "http://127.0.0.1:8001/auth/callback";
const CANVA_API_BASE = "https://api.canva.com/rest/v1";

type CanvaWidget = {
  id: string;
  title: string;
  templateUri: string;
  invoking: string;
  invoked: string;
  html: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const ASSETS_DIR = path.resolve(ROOT_DIR, "assets");

// Persistent token storage — survives server restarts and session reconnects
const TOKEN_FILE = path.resolve(ROOT_DIR, ".canva-tokens.json");

function loadPersistedTokens(): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (data.accessToken && data.refreshToken) return data;
    }
  } catch { /* ignore corrupt file */ }
  return null;
}

function persistTokens(tokens: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

// In-memory session map — populated from disk on new sessions
const authSessions = new Map<string, { accessToken: string; refreshToken: string; expiresAt: number }>();
const pendingAuthStates = new Map<string, { sessionId: string; createdAt: number; codeVerifier: string }>();

function readWidgetHtml(componentName: string): string {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "npm run build" before starting the server.`
    );
  }

  // Try direct path first
  const directPath = path.join(ASSETS_DIR, `${componentName}.html`);
  let htmlContents: string | null = null;

  if (fs.existsSync(directPath)) {
    htmlContents = fs.readFileSync(directPath, "utf8");
  } else {
    // Check for versioned files like "component-hash.html"
    const candidates = fs
      .readdirSync(ASSETS_DIR)
      .filter(
        (file) => file.startsWith(`${componentName}-`) && file.endsWith(".html")
      )
      .sort();
    const fallback = candidates[candidates.length - 1];
    if (fallback) {
      htmlContents = fs.readFileSync(path.join(ASSETS_DIR, fallback), "utf8");
    } else {
      // Check in src/components subdirectory as fallback
      const nestedPath = path.join(ASSETS_DIR, "src", "components", `${componentName}.html`);
      if (fs.existsSync(nestedPath)) {
        htmlContents = fs.readFileSync(nestedPath, "utf8");
      }
    }
  }

  if (!htmlContents) {
    throw new Error(
      `Widget HTML for "${componentName}" not found in ${ASSETS_DIR}. Run "npm run build" to generate the assets.`
    );
  }

  return htmlContents;
}

function widgetMeta(widget: CanvaWidget) {
  return {
    "openai/outputTemplate": widget.templateUri,
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
  } as const;
}

const widgets: CanvaWidget[] = [
  {
    id: "search-designs",
    title: "Canva Design Search",
    templateUri: "ui://widget/canva-search-designs.html",
    invoking: "Searching Canva",
    invoked: "Search complete",
    html: readWidgetHtml("canva-search-designs"),
  },
  {
    id: "design-generator",
    title: "Canva Design Generator",
    templateUri: "ui://widget/canva-design-generator.html",
    invoking: "Generating design",
    invoked: "Design generated",
    html: readWidgetHtml("canva-design-generator"),
  },
  {
    id: "design-editor",
    title: "Canva Design Editor",
    templateUri: "ui://widget/canva-design-editor.html",
    invoking: "Opening editor",
    invoked: "Editor ready",
    html: readWidgetHtml("canva-design-editor"),
  },
];

const widgetsById = new Map<string, CanvaWidget>();
const widgetsByUri = new Map<string, CanvaWidget>();

widgets.forEach((widget) => {
  widgetsById.set(widget.id, widget);
  widgetsByUri.set(widget.templateUri, widget);
});

// Tool input schemas — typed as ToolInputSchema to avoid `as any` casts at usage sites
const uploadAssetFromUrlSchema: ToolInputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Name for the asset",
    },
    url: {
      type: "string",
      description: "URL of the asset to upload",
    },
  },
  required: ["name", "url"],
  additionalProperties: false,
};

const searchDesignsSchema: ToolInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query for design title or content",
    },
    sortBy: {
      type: "string",
      enum: ["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"],
      description: "Sort order for results. Must be 'relevance' when using query parameter.",
    },
    ownershipFilter: {
      type: "string",
      enum: ["any", "owned", "shared"],
      description: "Filter by ownership (default: any)",
    },
    continuation: {
      type: "string",
      description: "Continuation token for pagination",
    },
  },
  additionalProperties: false,
};

const getDesignSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID to retrieve",
    },
  },
  required: ["designId"],
  additionalProperties: false,
};

const getDesignPagesSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
    offset: {
      type: "number",
      description: "Offset for pagination",
    },
    limit: {
      type: "number",
      description: "Limit for pagination",
    },
  },
  required: ["designId"],
  additionalProperties: false,
};

const getDesignContentSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
  },
  required: ["designId"],
  additionalProperties: false,
};

const createFolderSchema: ToolInputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Name of the folder",
    },
    parentFolderId: {
      type: "string",
      description: "Parent folder ID (optional, creates at root if not provided)",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

const moveItemToFolderSchema: ToolInputSchema = {
  type: "object",
  properties: {
    itemId: {
      type: "string",
      description: "ID of the item to move",
    },
    folderId: {
      type: "string",
      description: "Destination folder ID",
    },
  },
  required: ["itemId", "folderId"],
  additionalProperties: false,
};

const listFolderItemsSchema: ToolInputSchema = {
  type: "object",
  properties: {
    folderId: {
      type: "string",
      description: "Folder ID to list items from",
    },
    itemType: {
      type: "string",
      enum: ["design", "folder", "image"],
      description: "Filter by item type",
    },
    continuation: {
      type: "string",
      description: "Continuation token for pagination",
    },
  },
  required: ["folderId"],
  additionalProperties: false,
};

const commentOnDesignSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
    message: {
      type: "string",
      description: "Comment message text",
    },
  },
  required: ["designId", "message"],
  additionalProperties: false,
};

const listCommentsSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
    commentResolution: {
      type: "string",
      enum: ["resolved", "unresolved"],
      description: "Filter by resolution status",
    },
    continuation: {
      type: "string",
      description: "Continuation token for pagination",
    },
  },
  required: ["designId"],
  additionalProperties: false,
};

const listRepliesSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
    threadId: {
      type: "string",
      description: "The comment thread ID",
    },
    continuation: {
      type: "string",
      description: "Continuation token for pagination",
    },
  },
  required: ["designId", "threadId"],
  additionalProperties: false,
};

const replyToCommentSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID",
    },
    threadId: {
      type: "string",
      description: "The comment thread ID",
    },
    message: {
      type: "string",
      description: "Reply message text",
    },
  },
  required: ["designId", "threadId", "message"],
  additionalProperties: false,
};

const generateDesignSchema: ToolInputSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Detailed description of what to create (include all context from previous queries)",
    },
    assetIds: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Array of asset IDs to insert in order",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

const createDesignFromCandidateSchema: ToolInputSchema = {
  type: "object",
  properties: {
    jobId: {
      type: "string",
      description: "Generation job ID",
    },
    candidateId: {
      type: "string",
      description: "Candidate design ID",
    },
  },
  required: ["jobId", "candidateId"],
  additionalProperties: false,
};

const startEditingTransactionSchema: ToolInputSchema = {
  type: "object",
  properties: {
    designId: {
      type: "string",
      description: "The design ID to edit",
    },
  },
  required: ["designId"],
  additionalProperties: false,
};

const performEditingOperationsSchema: ToolInputSchema = {
  type: "object",
  properties: {
    transactionId: {
      type: "string",
      description: "The editing transaction ID",
    },
    operations: {
      type: "array",
      items: {
        type: "object",
      },
      description: "Array of editing operations to perform",
    },
  },
  required: ["transactionId", "operations"],
  additionalProperties: false,
};

const commitEditingTransactionSchema: ToolInputSchema = {
  type: "object",
  properties: {
    transactionId: {
      type: "string",
      description: "The editing transaction ID to commit",
    },
  },
  required: ["transactionId"],
  additionalProperties: false,
};

const cancelEditingTransactionSchema: ToolInputSchema = {
  type: "object",
  properties: {
    transactionId: {
      type: "string",
      description: "The editing transaction ID to cancel",
    },
  },
  required: ["transactionId"],
  additionalProperties: false,
};

const getDesignThumbnailSchema: ToolInputSchema = {
  type: "object",
  properties: {
    transactionId: {
      type: "string",
      description: "The editing transaction ID",
    },
    pageIndex: {
      type: "number",
      description: "The page index to get thumbnail for",
    },
  },
  required: ["transactionId", "pageIndex"],
  additionalProperties: false,
};

const getAssetsSchema: ToolInputSchema = {
  type: "object",
  properties: {
    assetIds: {
      type: "array",
      items: {
        type: "string",
      },
      description: "Array of asset IDs to retrieve",
    },
  },
  required: ["assetIds"],
  additionalProperties: false,
};

// Zod parsers
const uploadAssetFromUrlParser = z.object({
  name: z.string(),
  url: z.string().url(),
});

const searchDesignsParser = z.object({
  query: z.string().optional(),
  sortBy: z.enum(["relevance", "modified_descending", "modified_ascending", "title_descending", "title_ascending"]).optional(),
  ownershipFilter: z.enum(["any", "owned", "shared"]).optional(),
  continuation: z.string().optional(),
});

const getDesignParser = z.object({
  designId: z.string(),
});

const getDesignPagesParser = z.object({
  designId: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
});

const getDesignContentParser = z.object({
  designId: z.string(),
});

const createFolderParser = z.object({
  name: z.string(),
  parentFolderId: z.string().optional(),
});

const moveItemToFolderParser = z.object({
  itemId: z.string(),
  folderId: z.string(),
});

const listFolderItemsParser = z.object({
  folderId: z.string(),
  itemType: z.enum(["design", "folder", "image"]).optional(),
  continuation: z.string().optional(),
});

const commentOnDesignParser = z.object({
  designId: z.string(),
  message: z.string(),
});

const listCommentsParser = z.object({
  designId: z.string(),
  commentResolution: z.enum(["resolved", "unresolved"]).optional(),
  continuation: z.string().optional(),
});

const listRepliesParser = z.object({
  designId: z.string(),
  threadId: z.string(),
  continuation: z.string().optional(),
});

const replyToCommentParser = z.object({
  designId: z.string(),
  threadId: z.string(),
  message: z.string(),
});

const generateDesignParser = z.object({
  query: z.string(),
  assetIds: z.array(z.string()).optional(),
});

const createDesignFromCandidateParser = z.object({
  jobId: z.string(),
  candidateId: z.string(),
});

const startEditingTransactionParser = z.object({
  designId: z.string(),
});

const performEditingOperationsParser = z.object({
  transactionId: z.string(),
  operations: z.array(z.object({ type: z.string() }).passthrough()),
});

const commitEditingTransactionParser = z.object({
  transactionId: z.string(),
});

const cancelEditingTransactionParser = z.object({
  transactionId: z.string(),
});

const getDesignThumbnailParser = z.object({
  transactionId: z.string(),
  pageIndex: z.number(),
});

const getAssetsParser = z.object({
  assetIds: z.array(z.string()),
});

const tools: Tool[] = [
  {
    name: "upload-asset-from-url",
    description: 'Upload an asset (e.g. an image, a video) from a URL into Canva. If the API call returns "Missing scopes: [asset:write]", you should ask the user to disconnect and reconnect their connector. This will generate a new access token with the required scope for this tool.',
    inputSchema: uploadAssetFromUrlSchema,
    _meta: {
      "openai/widgetAccessible": false,
      "openai/toolInvocation/invoking": "Uploading asset to Canva",
      "openai/toolInvocation/invoked": "Asset uploaded",
    },
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "search-designs",
    description: "Search docs, presentations, videos, whiteboards, sheets, and other designs in Canva. Use 'query' parameter to search by title or content. If 'query' is used, 'sortBy' must be set to 'relevance'. Filter by 'any' ownership unless specified. Sort by relevance unless specified. Use the continuation token to get the next page of results, if needed.",
    inputSchema: searchDesignsSchema,
    _meta: widgetMeta(widgetsById.get("search-designs")!),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "get-design",
    description: "Get detailed information about a Canva design, such as a doc, presentation, whiteboard, video, or sheet. This includes design owner information, title, URLs for editing and viewing, thumbnail, created/updated time, and page count. This tool doesn't work on folders or images. You must provide the design ID, which you can find by using the `search-designs` or `list-folder-items` tools.",
    inputSchema: getDesignSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "get-design-pages",
    description: "Get a list of pages in a Canva design, such as a presentation. Each page includes its index and thumbnail. This tool doesn't work on designs that don't have pages (e.g. Canva docs). You must provide the design ID, which you can find using tools like `search-designs` or `list-folder-items`. You can use 'offset' and 'limit' to paginate through the pages. Use `get-design` to find out the total number of pages, if needed.",
    inputSchema: getDesignPagesSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "get-design-content",
    description: "Get the text content of a doc, presentation, whiteboard, social media post, sheet, and other designs in Canva. Use this when you only need to read text content without making changes. IMPORTANT: If the user wants to edit, update, change, translate, or fix content, use `start-editing-transaction` instead as it shows content AND enables editing. You must provide the design ID, which you can find with the `search-designs` tool. When given a URL to a Canva design, you can extract the design ID from the URL. Do not use web search to get the content of a design as the content is not accessible to the public. Example URL: https://www.canva.com/design/{design_id}.",
    inputSchema: getDesignContentSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "create-folder",
    description: "Create a new folder in Canva. You can create it at the root level or inside another folder.",
    inputSchema: createFolderSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "move-item-to-folder",
    description: "Move items (designs, folders, images) to a specified Canva folder",
    inputSchema: moveItemToFolderSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "list-folder-items",
    description: "List items in a Canva folder. An item can be a design, folder, or image. You can filter by item type and sort the results. Use the continuation token to get the next page of results if needed.",
    inputSchema: listFolderItemsSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "comment-on-design",
    description: "Add a comment on a Canva design. You need to provide the design ID and the message text. The comment will be added to the design and visible to all users with access to the design.",
    inputSchema: commentOnDesignSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "list-comments",
    description: "Get a list of comments for a particular Canva design. Comments are discussions attached to designs that help teams collaborate. Each comment can contain replies, mentions, and can be marked as resolved or unresolved. You need to provide the design ID, which you can find using the `search-designs` tool. Use the continuation token to get the next page of results, if needed. You can filter comments by their resolution status (resolved or unresolved) using the comment_resolution parameter.",
    inputSchema: listCommentsSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "list-replies",
    description: "Get a list of replies for a specific comment on a Canva design. Comments can contain multiple replies from different users. These replies help teams collaborate by allowing discussion on a specific comment. You need to provide the design ID and comment ID. You can find the design ID using the `search-designs` tool and the comment ID using the `list-comments` tool. Use the continuation token to get the next page of results, if needed.",
    inputSchema: listRepliesSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "reply-to-comment",
    description: "Reply to an existing comment on a Canva design. You need to provide the design ID, comment ID, and your reply message. The reply will be added to the specified comment and visible to all users with access to the design.",
    inputSchema: replyToCommentSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "generate-design",
    description: `Generate designs with AI.
Use the 'query' parameter to tell AI what you want to create.
The tool doesn't have context of previous requests. ALWAYS include details from previous queries for each iteration.
The tool provides best results with detailed context. ALWAYS look up the chat history and provide as much context as possible in the 'query' parameter.
Ask for more details when the tool returns this error message 'Common queries will not be generated'.
The generated designs are design candidates for users to select from.
Ask for a preferred design and use 'create-design-from-candidate' tool to add the design to users' account.
The IDs in the URLs are not design IDs. Do not use them to get design or design content.
When using the 'asset_ids' parameter, assets are inserted in the order provided. For small designs with few image slots, only supply the images the user wants. For multi-page designs like presentations, supply images in the order of the slides.
The tool will return a list of generated design candidates, including a candidate ID, preview thumbnail and url.
Before editing, exporting, or resizing a generated design, follow these steps:
1. call 'create-design-from-candidate' tool with 'job_id' and 'candidate_id' of the selected design
2. call other tools with 'design_id' in the response`,
    inputSchema: generateDesignSchema,
    _meta: widgetMeta(widgetsById.get("design-generator")!),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "create-design-from-candidate",
    description: "Create a new Canva design from a generation job candidate ID. This converts an AI-generated design candidate into an editable Canva design. If successful, returns a design summary containing a design ID that can be used with the editing tools. To make changes to the design, first call this tool with the candidate_id from generate-design results, then use the returned design_id with start-editing-transaction and subsequent editing tools.",
    inputSchema: createDesignFromCandidateSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "start-editing-transaction",
    description: "Start an editing session for a Canva design. Use this tool FIRST whenever a user wants to make ANY changes or examine ALL content of a design, including: - Translate text to another language - Edit or replace content - Update titles - Replace images - Fix typos or formatting - Auditing or reviewing content. This tool shows you all the content that can be modified AND provides an editing transaction ID for making changes. The `transaction_id` returned in the tool response MUST be remembered and MUST be used in all subsequent tool calls related to this specific editing transaction. Editing operations must be performed by the `perform-editing-operations` tool. To save the changes made in the transaction, use the `commit-editing-transaction` tool. To discard the changes made in the transaction, use the `cancel-editing-transaction` tool. IMPORTANT: ALWAYS ALWAYS ALWAYS show the preview to the user of EACH thumbnail you get in the response in the chat, EVERY SINGLE TIME you call this tool",
    inputSchema: startEditingTransactionSchema,
    _meta: widgetMeta(widgetsById.get("design-editor")!),
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "perform-editing-operations",
    description: "Perform editing operations on a design. You can use this tool to update the title, replace text, and replace media in a design. This tool needs to be used with the `start-editing-transaction` tool to obtain an editing transaction ID. Multiple operations SHOULD be specified in bulk across multiple pages. Always call this tool to apply the requested edits directly. This is safe: changes are temporary until committed. Do NOT pause for user confirmation before using this tool. After performing ALL operations requested by the user, always confirm with the user before finalizing changes using the `commit-editing-transaction` tool. This tool will return the thumbnail of the first page that is updated. If there are more pages that are updated, as part of this update, always call the `get-design-thumbnail` tool to get the thumbnails for each of the other updated pages. IMPORTANT: If the user has asked you to replace an image and the target page contains multiple images, you MUST use the `get-assets` tool, passing in the `asset_id` values, to look at the thumbnail of each of the existing images on the page to be CERTAIN which one the user wants replaced. Thumbnails returned by this tool are ALWAYS user-relevant and you need to render them directly using the full thumbnail URL including time-limited query parameters such as X-Amz-Algorithm, X-Amz-Credential, and X-Amz-Signature.",
    inputSchema: performEditingOperationsSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "commit-editing-transaction",
    description: 'Commit an editing transaction. This will save all the changes made to the design in the specified editing transaction. CRITICAL: You must ALWAYS ask the user to explicitly approve saving the changes before calling this tool. Show them what changes were made and ask "Would you like me to save these changes to your design?" Wait for their clear approval before proceeding. After successfully saving changes always provide the user with a direct link to open their design in Canva for review. Use the link they gave you or from the get-design tool. All editing operations are temporary until successfully committed. If the commit fails, ALL changes made during the transaction are lost and no changes are saved to the actual design. Users must start a new editing transaction to retry any failed operations. Once an editing transaction has been committed, the `transaction_id` for that editing transaction becomes invalid and should no longer be used.',
    inputSchema: commitEditingTransactionSchema,
    annotations: {
      destructiveHint: true,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "cancel-editing-transaction",
    description: "Cancel an editing transaction. This will discard all changes made to the design in the specified editing transaction. Once an editing transaction has been cancelled, the `transaction_id` for that editing transaction becomes invalid and should no longer be used.",
    inputSchema: cancelEditingTransactionSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: false,
    },
  },
  {
    name: "get-design-thumbnail",
    description: "Get the thumbnail for a particular page of the design in the specified editing transaction. This tool needs to be used with the `start-editing-transaction` tool to obtain an editing transaction ID. You need to provide the transaction ID and a page index to get the thumbnail of that particular page. Each call can only get the thumbnail for one page. Retrieving the thumbnails for multiple pages will require multiple calls of this tool. IMPORTANT: ALWAYS ALWAYS ALWAYS show the preview to the user of EACH thumbnail you get in the response in the chat, EVERY SINGLE TIME you call this tool",
    inputSchema: getDesignThumbnailSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
  {
    name: "get-assets",
    description: "Get metadata for particular assets by a list of their IDs. Returns information about ALL the assets including their names, tags, types, creation dates, and thumbnails. Thumbnails returned are in the same order as the list of asset IDs requested. When editing a page with more than one image or video asset ALWAYS request ALL assets from that page. IMPORTANT: ALWAYS ALWAYS ALWAYS show the preview to the user of EACH thumbnail you get in the response in the chat, EVERY SINGLE TIME you call this tool",
    inputSchema: getAssetsSchema,
    annotations: {
      destructiveHint: false,
      openWorldHint: false,
      readOnlyHint: true,
    },
  },
];

const resources: Resource[] = Array.from(widgetsById.values()).map((widget) => ({
  uri: widget.templateUri,
  name: widget.title,
  description: `${widget.title} widget markup`,
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

const resourceTemplates: ResourceTemplate[] = Array.from(widgetsById.values()).map((widget) => ({
  uriTemplate: widget.templateUri,
  name: widget.title,
  description: `${widget.title} widget markup`,
  mimeType: "text/html+skybridge",
  _meta: widgetMeta(widget),
}));

// OAuth helper functions with PKCE
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateAuthUrl(state: string, codeVerifier: string): string {
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const scopes = [
    "asset:read",
    "asset:write",
    "comment:read",
    "comment:write",
    "design:content:read",
    "design:content:write",
    "design:meta:read",
    "folder:read",
    "folder:write",
    "profile:read",
  ];

  const params = new URLSearchParams({
    client_id: CANVA_CLIENT_ID,
    response_type: "code",
    redirect_uri: CANVA_REDIRECT_URI,
    state: state,
    scope: scopes.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return `https://www.canva.com/api/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code: string, codeVerifier: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: CANVA_REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: CANVA_CLIENT_ID,
      client_secret: CANVA_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for token: ${response.statusText} - ${error}`);
  }

  return response.json();
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const response = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CANVA_CLIENT_ID,
      client_secret: CANVA_CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${response.statusText} - ${error}`);
  }

  return response.json();
}

async function getValidAccessToken(sessionId: string): Promise<string> {
  const session = authSessions.get(sessionId);
  
  if (!session) {
    // Try loading persisted tokens from disk
    const persisted = loadPersistedTokens();
    if (persisted) {
      authSessions.set(sessionId, persisted);
      return getValidAccessToken(sessionId);
    }
    throw new Error("Not authenticated. Please authenticate with Canva first.");
  }

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() >= session.expiresAt - 5 * 60 * 1000) {
    // Refresh the token
    const tokenData = await refreshAccessToken(session.refreshToken);
    session.accessToken = tokenData.access_token;
    session.expiresAt = Date.now() + tokenData.expires_in * 1000;
    authSessions.set(sessionId, session);
    persistTokens(session);
  }

  return session.accessToken;
}

async function canvaApiRequest(
  sessionId: string,
  endpoint: string,
  method: string = "GET",
  body?: any,
  accessTokenOverride?: string
): Promise<any> {
  const accessToken = accessTokenOverride || await getValidAccessToken(sessionId);
  
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
  };

  if (body && method !== "GET") {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${CANVA_API_BASE}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Canva API error:', response.status, error);
    throw new Error(`Canva API error: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function createCanvaServer(sessionId: string): Server {
  const server = new Server(
    {
      name: "canva-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources,
    })
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      const widget = widgetsByUri.get(request.params.uri);

      if (!widget) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }

      return {
        contents: [
          {
            uri: widget.templateUri,
            mimeType: "text/html+skybridge",
            text: widget.html,
            _meta: widgetMeta(widget),
          },
        ],
      };
    }
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates,
    })
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools,
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const toolName = request.params.name;

      // Check authentication for all tools
      // First check if we have session tokens
      let accessToken: string | null = null;
      
      if (authSessions.has(sessionId)) {
        accessToken = await getValidAccessToken(sessionId);
      } else {
        // Fallback: Check for Authorization header stored in session (from HTTP request)
        // This allows tokens from user profile to be passed via headers
        const storedAuthHeader = sessionAuthHeaders.get(sessionId);
        if (storedAuthHeader && storedAuthHeader.startsWith("Bearer ")) {
          accessToken = storedAuthHeader.substring(7);
          // Store in session for future use (without refresh token - will need re-auth when expired)
          authSessions.set(sessionId, {
            accessToken: accessToken,
            refreshToken: "", // We don't have refresh token from header
            expiresAt: Date.now() + 3600000, // Assume 1 hour expiration
          });
        }
      }

      if (!accessToken) {
        const state = crypto.randomBytes(16).toString("hex");
        const codeVerifier = generateCodeVerifier();
        pendingAuthStates.set(state, { sessionId, createdAt: Date.now(), codeVerifier });
        const authUrl = generateAuthUrl(state, codeVerifier);

        return {
          content: [
            {
              type: "text",
              text: `Please authenticate with Canva to use this feature. Visit: ${authUrl}`,
            },
          ],
        };
      }

      switch (toolName) {
        case "upload-asset-from-url": {
          const args = uploadAssetFromUrlParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(sessionId, "/url-asset-uploads", "POST", {
            name: args.name,
            url: args.url,
          }, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Successfully started asset upload job. Job ID: ${data.job.id}`,
              },
            ],
            structuredContent: data,
          };
        }

        case "search-designs": {
          const args = searchDesignsParser.parse(request.params.arguments ?? {});
          const widget = widgetsById.get("search-designs")!;

          const params = new URLSearchParams();
          if (args.query) {
            params.append("query", args.query);
            params.append("sort_by", "relevance");
          } else if (args.sortBy) {
            params.append("sort_by", args.sortBy);
          }
          
          if (args.ownershipFilter) {
            params.append("ownership", args.ownershipFilter);
          }
          
          if (args.continuation) {
            params.append("continuation", args.continuation);
          }

          const data = await canvaApiRequest(sessionId, `/designs?${params.toString()}`, "GET", undefined, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Found ${data.items?.length || 0} designs.`,
              },
            ],
            structuredContent: {
              query: args.query,
              designs: data.items || [],
              continuation: data.continuation,
            },
            _meta: widgetMeta(widget),
          };
        }

        case "get-design": {
          const args = getDesignParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(sessionId, `/designs/${args.designId}`, "GET", undefined, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Retrieved design: ${data.design.title}`,
              },
            ],
            structuredContent: data.design,
          };
        }

        case "get-design-pages": {
          const args = getDesignPagesParser.parse(request.params.arguments ?? {});
          
          const params = new URLSearchParams();
          if (args.offset !== undefined) params.append("offset", args.offset.toString());
          if (args.limit !== undefined) params.append("limit", args.limit.toString());

          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/pages?${params.toString()}`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Retrieved ${data.items?.length || 0} pages.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "get-design-content": {
          const args = getDesignContentParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(sessionId, `/designs/${args.designId}/content`, "GET", undefined, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Retrieved design content.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "create-folder": {
          const args = createFolderParser.parse(request.params.arguments ?? {});
          
          const body: any = { name: args.name };
          if (args.parentFolderId) {
            body.parent_folder_id = args.parentFolderId;
          }

          const data = await canvaApiRequest(sessionId, "/folders", "POST", body, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Successfully created folder: ${args.name}`,
              },
            ],
            structuredContent: data,
          };
        }

        case "move-item-to-folder": {
          const args = moveItemToFolderParser.parse(request.params.arguments ?? {});
          
          await canvaApiRequest(sessionId, `/folders/${args.folderId}/items`, "POST", {
            item_id: args.itemId,
          }, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Successfully moved item to folder.`,
              },
            ],
          };
        }

        case "list-folder-items": {
          const args = listFolderItemsParser.parse(request.params.arguments ?? {});
          
          const params = new URLSearchParams();
          if (args.itemType) params.append("item_type", args.itemType);
          if (args.continuation) params.append("continuation", args.continuation);

          const data = await canvaApiRequest(
            sessionId,
            `/folders/${args.folderId}/items?${params.toString()}`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Found ${data.items?.length || 0} items in folder.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "comment-on-design": {
          const args = commentOnDesignParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/comments`,
            "POST",
            {
              message_plaintext: args.message,
            },
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully added comment.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "list-comments": {
          const args = listCommentsParser.parse(request.params.arguments ?? {});
          
          const params = new URLSearchParams();
          if (args.commentResolution) params.append("comment_resolution", args.commentResolution);
          if (args.continuation) params.append("continuation", args.continuation);

          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/comments?${params.toString()}`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Found ${data.items?.length || 0} comments.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "list-replies": {
          const args = listRepliesParser.parse(request.params.arguments ?? {});
          
          const params = new URLSearchParams();
          if (args.continuation) params.append("continuation", args.continuation);

          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/comments/${args.threadId}/replies?${params.toString()}`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Found ${data.items?.length || 0} replies.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "reply-to-comment": {
          const args = replyToCommentParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/comments/${args.threadId}/replies`,
            "POST",
            {
              message_plaintext: args.message,
            },
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully added reply.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "generate-design": {
          const args = generateDesignParser.parse(request.params.arguments ?? {});
          const widget = widgetsById.get("design-generator")!;
          
          const body: any = { query: args.query };
          if (args.assetIds) {
            body.asset_ids = args.assetIds;
          }

          const data = await canvaApiRequest(sessionId, "/designs/generate", "POST", body, accessToken);

          return {
            content: [
              {
                type: "text",
                text: `Generated ${data.candidates?.length || 0} design candidates.`,
              },
            ],
            structuredContent: data,
            _meta: widgetMeta(widget),
          };
        }

        case "create-design-from-candidate": {
          const args = createDesignFromCandidateParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/generate/${args.jobId}/candidates/${args.candidateId}`,
            "POST",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully created design from candidate.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "start-editing-transaction": {
          const args = startEditingTransactionParser.parse(request.params.arguments ?? {});
          const widget = widgetsById.get("design-editor")!;
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/${args.designId}/edit`,
            "POST",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Started editing transaction. Transaction ID: ${data.transaction_id}`,
              },
            ],
            structuredContent: data,
            _meta: widgetMeta(widget),
          };
        }

        case "perform-editing-operations": {
          const args = performEditingOperationsParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/edit/${args.transactionId}/operations`,
            "POST",
            {
              operations: args.operations,
            },
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully performed editing operations.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "commit-editing-transaction": {
          const args = commitEditingTransactionParser.parse(request.params.arguments ?? {});
          
          await canvaApiRequest(
            sessionId,
            `/designs/edit/${args.transactionId}/commit`,
            "POST",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully committed changes to design.`,
              },
            ],
          };
        }

        case "cancel-editing-transaction": {
          const args = cancelEditingTransactionParser.parse(request.params.arguments ?? {});
          
          await canvaApiRequest(
            sessionId,
            `/designs/edit/${args.transactionId}/cancel`,
            "POST",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Successfully cancelled editing transaction.`,
              },
            ],
          };
        }

        case "get-design-thumbnail": {
          const args = getDesignThumbnailParser.parse(request.params.arguments ?? {});
          
          const data = await canvaApiRequest(
            sessionId,
            `/designs/edit/${args.transactionId}/pages/${args.pageIndex}/thumbnail`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Retrieved thumbnail for page ${args.pageIndex}.`,
              },
            ],
            structuredContent: data,
          };
        }

        case "get-assets": {
          const args = getAssetsParser.parse(request.params.arguments ?? {});
          
          const params = new URLSearchParams();
          args.assetIds.forEach(id => params.append("asset_ids", id));

          const data = await canvaApiRequest(
            sessionId,
            `/assets?${params.toString()}`,
            "GET",
            undefined,
            accessToken
          );

          return {
            content: [
              {
                type: "text",
                text: `Retrieved ${data.items?.length || 0} assets.`,
              },
            ],
            structuredContent: data,
          };
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
  authHeader?: string; // Store Authorization header from HTTP requests
};

const sessions = new Map<string, SessionRecord>();
// Map to store auth headers by sessionId (for looking up during tool calls)
const sessionAuthHeaders = new Map<string, string>();
// Map from transport.sessionId to actualSessionId (used in createCanvaServer closure)
const transportToSessionId = new Map<string, string>();

const ssePath = "/mcp";
const postPath = "/mcp/messages";
const authCallbackPath = "/auth/callback";

async function handleSseRequest(res: ServerResponse, sessionId?: string, authHeader?: string) {
  const actualSessionId = sessionId || crypto.randomBytes(16).toString("hex");
  const server = createCanvaServer(actualSessionId);
  const transport = new SSEServerTransport(postPath, res);

  // Store mapping from transport.sessionId to actualSessionId
  transportToSessionId.set(transport.sessionId, actualSessionId);
  
  // Store auth header if provided (use actualSessionId which matches the closure in createCanvaServer)
  if (authHeader) {
    sessionAuthHeaders.set(actualSessionId, authHeader);
  }

  sessions.set(transport.sessionId, { server, transport, authHeader });

  transport.onclose = async () => {
    const sessionId = transport.sessionId;
    // Guard against recursive close (server.close triggers transport.onclose)
    if (!sessions.has(sessionId)) return;
    const mappedSessionId = transportToSessionId.get(sessionId);
    if (mappedSessionId) {
      sessionAuthHeaders.delete(mappedSessionId);
      transportToSessionId.delete(sessionId);
    }
    sessions.delete(sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("SSE transport error", error);
  };

  try {
    await server.connect(transport);
  } catch (error) {
    sessions.delete(transport.sessionId);
    console.error("Failed to start SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }

  const session = sessions.get(sessionId);

  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }

  // Extract Authorization header from HTTP request and store in session
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const authHeaderStr = typeof authHeader === "string" ? authHeader : authHeader[0];
    session.authHeader = authHeaderStr;
    // Map transport.sessionId to actualSessionId and store authHeader with actualSessionId
    const actualSessionId = transportToSessionId.get(sessionId);
    if (actualSessionId) {
      sessionAuthHeaders.set(actualSessionId, authHeaderStr);
    } else {
      // Fallback: also store with transport.sessionId in case mapping doesn't exist yet
      sessionAuthHeaders.set(sessionId, authHeaderStr);
    }
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

async function handleAuthCallback(req: IncomingMessage, res: ServerResponse, url: URL) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(`
      <html>
        <body>
          <h1>Authentication Failed</h1>
          <p>Error: ${escapeHtml(error)}</p>
          <p>Please try again.</p>
        </body>
      </html>
    `);
    return;
  }

  if (!code || !state) {
    res.writeHead(400).end("Missing code or state parameter");
    return;
  }

  const pendingAuth = pendingAuthStates.get(state);
  
  if (!pendingAuth) {
    res.writeHead(400).end("Invalid or expired state parameter");
    return;
  }

  // Clean up old states (older than 10 minutes)
  const now = Date.now();
  for (const [key, value] of pendingAuthStates.entries()) {
    if (now - value.createdAt > 10 * 60 * 1000) {
      pendingAuthStates.delete(key);
    }
  }

  try {
    const tokenData = await exchangeCodeForToken(code, pendingAuth.codeVerifier);
    
    const tokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };
    authSessions.set(pendingAuth.sessionId, tokens);
    persistTokens(tokens);

    pendingAuthStates.delete(state);

    res.writeHead(200, { "Content-Type": "text/html" }).end(`
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
          <div style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px;">
            <h1 style="color: #667eea; margin-bottom: 1rem;">Successfully Connected to Canva!</h1>
            <p style="color: #555;">You can now close this window and return to your chat.</p>
            <script>
              setTimeout(() => window.close(), 2000);
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error("Failed to exchange code for token", error);
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    res.writeHead(500, { "Content-Type": "text/html" }).end(`
      <html>
        <body>
          <h1>Authentication Error</h1>
          <p>${escapeHtml(errorMessage)}</p>
          <p>Please try again.</p>
        </body>
      </html>
    `);
  }
}

const portEnv = Number(process.env.PORT ?? 8001);
const port = Number.isFinite(portEnv) ? portEnv : 8001;

// HTML entity encoder — no dependencies, covers XSS vectors
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Auth middleware for MCP endpoints
// If MCP_AUTH_TOKEN is set, require matching Bearer token. Dev mode allows unauthenticated.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
if (!MCP_AUTH_TOKEN) {
  console.warn("[WARN] MCP_AUTH_TOKEN is not set. Running in dev mode — MCP endpoints are unauthenticated.");
}

function checkMcpAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!MCP_AUTH_TOKEN) {
    return true; // dev mode
  }
  const authHeader = req.headers.authorization || "";
  const token = typeof authHeader === "string"
    ? authHeader.replace(/^Bearer\s+/i, "")
    : "";
  // Timing-safe comparison
  const expected = Buffer.from(MCP_AUTH_TOKEN);
  const provided = Buffer.from(token.length === expected.length ? token : "\0".repeat(expected.length));
  const match = crypto.timingSafeEqual(expected, provided) && token.length === MCP_AUTH_TOKEN.length;
  if (!match) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
    return false;
  }
  return true;
}

// Helper function to set CORS headers
// Only reflects origin when it is in the allowlist. Wildcard fallback is intentionally removed.
// Configure allowed origins via CORS_ORIGINS env var (comma-separated), default: http://localhost:5173
const rawCorsOrigins = process.env.CORS_ORIGINS || "http://localhost:5173";
const allowedCorsOrigins = rawCorsOrigins.split(",").map((o) => o.trim()).filter(Boolean);

function setCorsHeaders(res: ServerResponse, origin?: string) {
  const allowOrigin = origin && allowedCorsOrigins.includes(origin) ? origin : null;

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
}

const httpServer = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    
    // Set CORS headers on all responses
    setCorsHeaders(res, origin);
    
    if (!req.url) {
      res.writeHead(400).end("Missing URL");
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (
      req.method === "OPTIONS" &&
      (url.pathname === ssePath || url.pathname === postPath)
    ) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === ssePath) {
      if (!checkMcpAuth(req, res)) return;
      // Extract Authorization header if present
      const authHeader = req.headers.authorization;
      const authHeaderStr = authHeader ? (typeof authHeader === "string" ? authHeader : authHeader[0]) : undefined;
      await handleSseRequest(res, undefined, authHeaderStr);
      return;
    }

    if (req.method === "POST" && url.pathname === postPath) {
      if (!checkMcpAuth(req, res)) return;
      await handlePostMessage(req, res, url);
      return;
    }

    if (req.method === "GET" && url.pathname === authCallbackPath) {
      await handleAuthCallback(req, res, url);
      return;
    }

    // Serve static assets for widgets
    if (req.method === "GET") {
      const assetPath = url.pathname.slice(1);
      const fullPath = path.join(ASSETS_DIR, assetPath);
      const resolvedPath = path.resolve(fullPath);
      
      if (!resolvedPath.startsWith(path.resolve(ASSETS_DIR))) {
        res.writeHead(403).end("Forbidden");
        return;
      }

      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        const ext = path.extname(resolvedPath).toLowerCase();
        const contentTypes: { [key: string]: string } = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
        };
        const contentType = contentTypes[ext] || "application/octet-stream";
        
        res.writeHead(200, {
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        fs.createReadStream(resolvedPath).pipe(res);
        return;
      }
    }

    res.writeHead(404).end("Not Found");
  }
);

httpServer.on("clientError", (err: Error, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`Canva MCP server listening on http://127.0.0.1:${port}`);
  console.log(`  SSE stream: GET http://127.0.0.1:${port}${ssePath}`);
  console.log(`  Message post endpoint: POST http://127.0.0.1:${port}${postPath}?sessionId=...`);
  console.log(`  OAuth callback: GET http://127.0.0.1:${port}${authCallbackPath}`);
  console.log(`\nMake sure to set your environment variables:`);
  console.log(`  CANVA_CLIENT_ID=<your_client_id>`);
  console.log(`  CANVA_CLIENT_SECRET=<your_client_secret>`);
  console.log(`  CANVA_REDIRECT_URI=${CANVA_REDIRECT_URI}`);
});

