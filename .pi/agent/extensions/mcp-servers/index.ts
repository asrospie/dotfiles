import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

type OAuthConfig = {
	callbackPort?: number;
	clientName?: string;
	scope?: string;
	clientMetadataUrl?: string;
};

type ServerConfig = {
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: boolean | OAuthConfig;
};

type ConfigFile = { mcpServers?: Record<string, ServerConfig>; servers?: Record<string, ServerConfig> };
type ConnectedServer = { name: string; client: Client; close: () => Promise<void> };
type LoadedServer = { config: ServerConfig; cwdConfigPath: string };
type OAuthRecord = {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
};
type OAuthFile = { version: 1; servers: Record<string, OAuthRecord> };

const DEFAULT_CALLBACK_PORT = 33445;

function interpolate(value: string): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? "");
}

function interpolateRecord(record: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, interpolate(value)]));
}

function toolName(serverName: string, name: string): string {
	const safe = `${serverName}_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	return `mcp_${safe || "tool"}`.slice(0, 64);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oauthOptions(config: ServerConfig): OAuthConfig | undefined {
	if (config.oauth === true) return {};
	return config.oauth && typeof config.oauth === "object" ? config.oauth : undefined;
}

function callbackUrl(serverName: string, options: OAuthConfig): string {
	const port = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`MCP OAuth callbackPort for ${JSON.stringify(serverName)} must be between 1 and 65535`);
	}
	return `http://localhost:${port}/mcp-oauth/${encodeURIComponent(serverName)}`;
}

async function readConfig(path: string): Promise<ConfigFile | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("top-level value must be an object");
		}
		return parsed as ConfigFile;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${path}: ${formatError(error)}`);
	}
}

function mergeServerConfig(previous: ServerConfig | undefined, next: ServerConfig): ServerConfig {
	return {
		...previous,
		...next,
		env: { ...previous?.env, ...next.env },
		headers: { ...previous?.headers, ...next.headers },
	};
}

async function loadServers(globalPath: string, projectPath: string | undefined): Promise<Map<string, LoadedServer>> {
	const servers = new Map<string, LoadedServer>();
	for (const path of [globalPath, projectPath]) {
		if (!path) continue;
		const config = await readConfig(path);
		for (const [name, server] of Object.entries(config?.mcpServers ?? config?.servers ?? {})) {
			if (!server || typeof server !== "object" || Array.isArray(server)) {
				throw new Error(`${path}: server ${JSON.stringify(name)} must be an object`);
			}
			const previous = servers.get(name);
			servers.set(name, {
				config: mergeServerConfig(previous?.config, server),
				cwdConfigPath: Object.hasOwn(server, "cwd") ? path : previous?.cwdConfigPath ?? path,
			});
		}
	}
	return servers;
}

async function listAllTools(client: Client) {
	const tools = [] as Awaited<ReturnType<Client["listTools"]>>["tools"];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined);
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

class OAuthStore {
	private data: OAuthFile | undefined;

	constructor(private readonly path: string) {}

	private async load(): Promise<OAuthFile> {
		if (this.data) return this.data;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("top-level value must be an object");
			const candidate = parsed as Partial<OAuthFile>;
			this.data = { version: 1, servers: candidate.servers && typeof candidate.servers === "object" ? candidate.servers : {} };
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${this.path}: ${formatError(error)}`);
			this.data = { version: 1, servers: {} };
		}
		return this.data;
	}

	async get(id: string): Promise<OAuthRecord> {
		return (await this.load()).servers[id] ?? {};
	}

	async update(id: string, update: (record: OAuthRecord) => OAuthRecord): Promise<void> {
		const data = await this.load();
		data.servers[id] = update(data.servers[id] ?? {});
		await this.save(data);
	}

	async clear(id: string): Promise<void> {
		const data = await this.load();
		delete data.servers[id];
		await this.save(data);
	}

	private async save(data: OAuthFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.path);
		await chmod(this.path, 0o600);
	}
}

class StoredOAuthProvider implements OAuthClientProvider {
	constructor(
		private readonly store: OAuthStore,
		private readonly id: string,
		private readonly redirect: string,
		private readonly metadata: OAuthClientMetadata,
		private readonly authorizationState: string,
		private readonly onAuthorization: (url: URL) => Promise<void>,
		readonly clientMetadataUrl?: string,
	) {}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.metadata;
	}

	state(): string {
		return this.authorizationState;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return (await this.store.get(this.id)).clientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		await this.store.update(this.id, (record) => ({ ...record, clientInformation }));
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.store.get(this.id)).tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.store.update(this.id, (record) => ({ ...record, tokens }));
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		await this.onAuthorization(authorizationUrl);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.store.update(this.id, (record) => ({ ...record, codeVerifier }));
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.store.get(this.id)).codeVerifier;
		if (!verifier) throw new Error("No OAuth PKCE verifier is available; start authentication again");
		return verifier;
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		await this.store.update(this.id, (record) => ({ ...record, discoveryState }));
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.store.get(this.id)).discoveryState;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.store.update(this.id, (record) => {
			const next = { ...record };
			if (scope === "all" || scope === "client") delete next.clientInformation;
			if (scope === "all" || scope === "tokens") delete next.tokens;
			if (scope === "all" || scope === "verifier") delete next.codeVerifier;
			if (scope === "all" || scope === "discovery") delete next.discoveryState;
			return next;
		});
	}
}

type OAuthCallback = { url: string; waitForCode: () => Promise<string>; close: () => Promise<void> };

async function startOAuthCallback(serverName: string, options: OAuthConfig, state: string): Promise<OAuthCallback> {
	const url = new URL(callbackUrl(serverName, options));
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
	let settled = false;
	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", url);
		if (requestUrl.pathname !== url.pathname) {
			response.writeHead(404).end("Not found");
			return;
		}
		const error = requestUrl.searchParams.get("error");
		const receivedState = requestUrl.searchParams.get("state");
		const receivedCode = requestUrl.searchParams.get("code");
		if (receivedState !== state) {
			response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>OAuth authorization failed</h1><p>Invalid state.</p>");
			if (!settled) { settled = true; rejectCode(new Error("OAuth callback state did not match")); }
			return;
		}
		if (error || !receivedCode) {
			response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end("<h1>OAuth authorization failed</h1><p>Return to Pi and try again.</p>");
			if (!settled) { settled = true; rejectCode(new Error(`OAuth authorization failed${error ? `: ${error}` : ""}`)); }
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>Authorization complete</h1><p>You can close this tab and return to Pi.</p>");
		if (!settled) { settled = true; resolveCode(receivedCode); }
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(Number(url.port), "127.0.0.1", () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	return {
		url: url.toString(),
		waitForCode: () => code,
		close: async () => {
			if (!settled) { settled = true; rejectCode(new Error("OAuth authentication was cancelled")); }
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

function openBrowser(url: URL): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url.toString()] : [url.toString()];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

async function connect(name: string, config: ServerConfig, configPath: string): Promise<ConnectedServer> {
	const client = new Client({ name: "pi-mcp-servers", version: "1.1.0" });
	if (config.command) {
		const cwd = config.cwd ? (isAbsolute(config.cwd) ? config.cwd : resolve(dirname(configPath), config.cwd)) : undefined;
		const transport = new StdioClientTransport({
			command: interpolate(config.command),
			args: config.args?.map(interpolate),
			env: { ...getDefaultEnvironment(), ...interpolateRecord(config.env) },
			cwd,
		});
		await client.connect(transport);
		return { name, client, close: () => transport.close() };
	}
	if (config.url) {
		const transport = new StreamableHTTPClientTransport(new URL(interpolate(config.url)), {
			requestInit: { headers: interpolateRecord(config.headers) },
		});
		await client.connect(transport);
		return { name, client, close: () => transport.close() };
	}
	throw new Error(`MCP server ${JSON.stringify(name)} needs either "command" (stdio) or "url" (Streamable HTTP)`);
}

async function connectWithOAuth(
	name: string,
	config: ServerConfig,
	options: OAuthConfig,
	store: OAuthStore,
	interactive: boolean,
	onAuthorization: (url: URL) => Promise<void>,
): Promise<ConnectedServer> {
	if (!config.url) throw new Error(`MCP OAuth server ${JSON.stringify(name)} needs a "url"`);
	const id = `${name}:${interpolate(config.url)}`;
	if (!interactive && !(await store.get(id)).tokens) {
		throw new Error("OAuth sign-in required");
	}
	const state = randomBytes(32).toString("base64url");
	const redirect = callbackUrl(name, options);
	const provider = new StoredOAuthProvider(store, id, redirect, {
		client_name: options.clientName ?? "Pi MCP Servers",
		redirect_uris: [redirect],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		scope: options.scope,
	}, state, onAuthorization, options.clientMetadataUrl);
	const makeTransport = () => new StreamableHTTPClientTransport(new URL(interpolate(config.url!)), {
		authProvider: provider,
		requestInit: { headers: interpolateRecord(config.headers) },
	});
	const callback = interactive ? await startOAuthCallback(name, options, state) : undefined;
	const client = new Client({ name: "pi-mcp-servers", version: "1.1.0" });
	let transport = makeTransport();
	try {
		try {
			await client.connect(transport);
			return { name, client, close: () => transport.close() };
		} catch (error) {
			if (!(error instanceof UnauthorizedError) || !interactive || !callback) throw error;
			const authorizationCode = await callback.waitForCode();
			await transport.finishAuth(authorizationCode);
			transport = makeTransport();
			await client.connect(transport);
			return { name, client, close: () => transport.close() };
		}
	} finally {
		await callback?.close().catch(() => {});
	}
}

export default function mcpServersExtension(pi: ExtensionAPI) {
	const connections = new Map<string, ConnectedServer>();
	const registeredNames = new Set<string>();
	const configuredServers = new Map<string, LoadedServer>();
	const oauthStore = new OAuthStore(join(getAgentDir(), "mcp-oauth.json"));
	let started = false;

	const registerConnection = async (connection: ConnectedServer, ctx: ExtensionContext) => {
		if (connections.has(connection.name)) return;
		try {
			for (const tool of await listAllTools(connection.client)) {
				const name = toolName(connection.name, tool.name);
				if (registeredNames.has(name)) {
					ctx.ui.notify(`MCP tool collision: ${name} was skipped`, "warning");
					continue;
				}
				registeredNames.add(name);
				pi.registerTool({
					name,
					label: tool.title ?? `${connection.name}: ${tool.name}`,
					description: `[MCP ${connection.name}] ${tool.description ?? tool.name}`,
					promptSnippet: `[MCP ${connection.name}] ${tool.description ?? tool.name}`,
					parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
					async execute(_toolCallId, params, signal) {
						const result = await connection.client.callTool({ name: tool.name, arguments: params }, undefined, { signal });
						if (!("content" in result)) return { content: [{ type: "text", text: JSON.stringify(result) }], details: { server: connection.name, tool: tool.name } };
						const text = result.content.map((item) => item.type === "text" ? item.text : JSON.stringify(item)).join("\n");
						if (result.isError) throw new Error(text || `MCP tool ${tool.name} failed`);
						return { content: [{ type: "text", text: text || "(MCP tool returned no content)" }], details: { server: connection.name, tool: tool.name, structuredContent: result.structuredContent } };
					},
				});
			}
			connections.set(connection.name, connection);
		} catch (error) {
			await connection.close().catch(() => {});
			throw error;
		}
	};

	const connectConfiguredServer = async (name: string, loaded: LoadedServer, ctx: ExtensionContext, interactive: boolean) => {
		if (connections.has(name)) return;
		const options = oauthOptions(loaded.config);
		const connection = options
			? await connectWithOAuth(name, loaded.config, options, oauthStore, interactive, async (url) => {
				if (!interactive) throw new Error("OAuth sign-in required");
				ctx.ui.notify(`Open this URL to sign in to MCP server ${name}:\n${url}`, "info");
				openBrowser(url);
			})
			: await connect(name, loaded.config, loaded.cwdConfigPath);
		await registerConnection(connection, ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (started) return;
		started = true;
		const globalPath = join(getAgentDir(), "mcp.json");
		const projectPath = ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
		try {
			for (const [name, loaded] of await loadServers(globalPath, projectPath)) configuredServers.set(name, loaded);
		} catch (error) {
			ctx.ui.notify(`MCP configuration error: ${formatError(error)}`, "error");
			return;
		}
		for (const [name, loaded] of configuredServers) {
			if (loaded.config.enabled === false) continue;
			try {
				await connectConfiguredServer(name, loaded, ctx, false);
			} catch (error) {
				const message = formatError(error);
				ctx.ui.notify(oauthOptions(loaded.config) && message === "OAuth sign-in required" ? `MCP server ${name} requires sign-in. Run /mcp auth ${name}.` : `MCP server ${name} failed: ${message}`, "warning");
			}
		}
		if (connections.size > 0) ctx.ui.notify(`MCP: connected ${connections.size} server${connections.size === 1 ? "" : "s"}`, "info");
	});

	pi.on("session_shutdown", async () => {
		await Promise.allSettled([...connections.values()].map((connection) => connection.close()));
		connections.clear();
	});

	pi.registerCommand("mcp", {
		description: "Show MCP status, authenticate, or remove OAuth credentials: /mcp [auth|logout] <server>",
		handler: async (args, ctx) => {
			const [action, serverName] = args.trim().split(/\s+/, 2);
			if (action === "auth") {
				const loaded = configuredServers.get(serverName);
				if (!loaded || !oauthOptions(loaded.config)) {
					ctx.ui.notify(`No OAuth-enabled MCP server named ${JSON.stringify(serverName ?? "")}.`, "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("OAuth sign-in requires interactive Pi or RPC mode.", "warning");
					return;
				}
				try {
					await connectConfiguredServer(serverName, loaded, ctx, true);
					ctx.ui.notify(`MCP server ${serverName} authenticated and connected.`, "info");
				} catch (error) {
					ctx.ui.notify(`MCP OAuth for ${serverName} failed: ${formatError(error)}`, "error");
				}
				return;
			}
			if (action === "logout") {
				const loaded = configuredServers.get(serverName);
				if (!loaded || !oauthOptions(loaded.config)) {
					ctx.ui.notify(`No OAuth-enabled MCP server named ${JSON.stringify(serverName ?? "")}.`, "warning");
					return;
				}
				await oauthStore.clear(`${serverName}:${interpolate(loaded.config.url ?? "")}`);
				ctx.ui.notify(`Deleted OAuth credentials for MCP server ${serverName}. Restart or /reload before signing in again.`, "info");
				return;
			}
			const tools = [...registeredNames].sort();
			ctx.ui.notify(
				configuredServers.size ? `MCP servers: ${[...configuredServers.keys()].join(", ")}\nConnected: ${[...connections.keys()].join(", ") || "none"}\nTools: ${tools.join(", ") || "none"}` : "No MCP servers configured. Add one to mcp.json and /reload.",
				configuredServers.size ? "info" : "warning",
			);
		},
	});
}
