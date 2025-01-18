import fs from "fs";
import { AddressInfo } from "net";
import { fileURLToPath } from "url";
import path from "path";
import { Plugin, loadEnv, UserConfig, ConfigEnv, ResolvedConfig } from "vite";

interface PluginConfig {
  /**
   * The name of the plugin.
   * @default 'backend'
   */
  name?: string;

  /**
   * The path or paths of the entry points to compile.
   */
  input: string | string[];

  /**
   * Backend's public directory.
   *
   * @default 'public'
   */
  publicDirectory?: string;

  /**
   * The public subdirectory where compiled assets should be written.
   *
   * @default 'build'
   */
  buildDirectory?: string;

  /**
   * The path to the "hot" file.
   *
   * @default `${publicDirectory}/hot`
   */
  hotFile?: string;

  /**
   * Utilize the Herd or Valet TLS certificates.
   *
   * @default null
   */
  detectTls?: string | boolean | null;

  /**
   * Transform the code while serving.
   */
  transformOnServe?: (code: string, url: DevServerUrl) => string;
}

interface BackendPlugin extends Plugin {
  config: (config: UserConfig, env: ConfigEnv) => UserConfig;
}

type DevServerUrl = `${"http" | "https"}://${string}:${number}`;

let exitHandlersBound = false;

/**
 * Backend plugin for Vite.
 *
 * @param config - A config object or relative path(s) of the scripts to be compiled.
 */
export default function backend(config: string | string[] | PluginConfig): BackendPlugin {
  const pluginConfig = resolvePluginConfig(config);
  return resolveBackendPlugin(pluginConfig);
}

/**
 * Resolve the Backend Plugin configuration.
 */
function resolveBackendPlugin(pluginConfig: Required<PluginConfig>): BackendPlugin {
  let viteDevServerUrl: DevServerUrl;
  let resolvedConfig: ResolvedConfig;
  let userConfig: UserConfig;

  return {
    name: "backend",
    enforce: "post",
    config: (config, { command, mode }) => {
      userConfig = config;
      const env = loadEnv(mode, userConfig.envDir || process.cwd(), "");
      const assetUrl = env.ASSET_URL ?? "";
      const serverConfig = command === "serve" ? resolveEnvironmentServerConfig(env) : undefined;

      return {
        base: userConfig.base ?? (command === "build" ? resolveBase(pluginConfig, assetUrl) : ""),
        publicDir: userConfig.publicDir ?? false,
        build: {
          manifest: userConfig.build?.manifest ?? "manifest.json",
          outDir: userConfig.build?.outDir ?? resolveOutDir(pluginConfig),
          rollupOptions: {
            input: userConfig.build?.rollupOptions?.input ?? resolveInput(pluginConfig),
          },
          assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
        },
        server: {
          origin: userConfig.server?.origin ?? "__backend_vite_placeholder__",
          ...(serverConfig
            ? {
                host: userConfig.server?.host ?? serverConfig.host,
                hmr:
                  userConfig.server?.hmr === false
                    ? false
                    : {
                        ...serverConfig.hmr,
                        ...(userConfig.server?.hmr === true ? {} : userConfig.server?.hmr),
                      },
                https: userConfig.server?.https ?? serverConfig.https,
              }
            : undefined),
        },
        resolve: {
          alias: Array.isArray(userConfig.resolve?.alias)
            ? [...(userConfig.resolve?.alias ?? [])]
            : {
                ...userConfig.resolve?.alias,
              },
        },
      };
    },
    configResolved(config) {
      resolvedConfig = config;
    },
    transform(code) {
      if (resolvedConfig.command === "serve") {
        code = code.replace(/__backend_vite_placeholder__/g, viteDevServerUrl);
        return pluginConfig.transformOnServe(code, viteDevServerUrl);
      }
    },
    configureServer(server) {
      const envDir = resolvedConfig.envDir || process.cwd();
      const appUrl = loadEnv(resolvedConfig.mode, envDir, "APP_URL").APP_URL ?? "undefined";

      server.httpServer?.once("listening", () => {
        const address = server.httpServer?.address();

        const isAddressInfo = (x: string | AddressInfo | null | undefined): x is AddressInfo => typeof x === "object";
        if (isAddressInfo(address)) {
          viteDevServerUrl = userConfig.server?.origin
            ? (userConfig.server.origin as DevServerUrl)
            : resolveDevServerUrl(address, server.config);
          fs.writeFileSync(pluginConfig.hotFile, viteDevServerUrl);
        }
      });

      if (!exitHandlersBound) {
        const clean = () => {
          if (fs.existsSync(pluginConfig.hotFile)) {
            fs.rmSync(pluginConfig.hotFile);
          }
        };

        process.on("exit", clean);
        process.on("SIGINT", () => process.exit());
        process.on("SIGTERM", () => process.exit());
        process.on("SIGHUP", () => process.exit());

        exitHandlersBound = true;
      }

      return () =>
        server.middlewares.use((req, res, next) => {
          if (req.url === "/index.html") {
            res.statusCode = 404;

            res.end(
              fs
                .readFileSync(path.join(dirname(), "dev-server-index.html"))
                .toString()
                .replace(/{{ APP_URL }}/g, appUrl),
            );
          }

          next();
        });
    },
  };
}

/**
 * Convert the users configuration into a standard structure with defaults.
 */
function resolvePluginConfig(config: string | string[] | PluginConfig): Required<PluginConfig> {
  if (typeof config === "undefined") {
    throw new Error("vite-plugin-backend: missing configuration.");
  }

  if (typeof config === "string" || Array.isArray(config)) {
    config = { input: config };
  }

  if (typeof config.input === "undefined") {
    throw new Error('vite-plugin-backend: missing configuration for "input".');
  }

  if (typeof config.publicDirectory === "string") {
    config.publicDirectory = config.publicDirectory.trim().replace(/^\/+/, "");

    if (config.publicDirectory === "") {
      throw new Error("vite-plugin-backend: publicDirectory must be a subdirectory. E.g. 'public'.");
    }
  }

  if (typeof config.buildDirectory === "string") {
    config.buildDirectory = config.buildDirectory.trim().replace(/^\/+/, "").replace(/\/+$/, "");

    if (config.buildDirectory === "") {
      throw new Error("vite-plugin-backend: buildDirectory must be a subdirectory. E.g. 'build'.");
    }
  }

  return {
    name: config.name ?? "backend",
    input: config.input,
    publicDirectory: config.publicDirectory ?? "public",
    buildDirectory: config.buildDirectory ?? "build",
    hotFile: config.hotFile ?? path.join(config.publicDirectory ?? "public", "hot"),
    detectTls: config.detectTls ?? null,
    transformOnServe: config.transformOnServe ?? ((code) => code),
  };
}

/**
 * Resolve the Vite base option from the configuration.
 */
function resolveBase(config: Required<PluginConfig>, assetUrl: string): string {
  return assetUrl + (!assetUrl.endsWith("/") ? "/" : "") + config.buildDirectory + "/";
}

/**
 * Resolve the Vite input path from the configuration.
 */
function resolveInput(config: Required<PluginConfig>): string | string[] | undefined {
  return config.input;
}

/**
 * Resolve the Vite outDir path from the configuration.
 */
function resolveOutDir(config: Required<PluginConfig>): string | undefined {
  return path.join(config.publicDirectory, config.buildDirectory);
}

/**
 * Resolve the dev server URL from the server address and configuration.
 */
function resolveDevServerUrl(address: AddressInfo, config: ResolvedConfig): DevServerUrl {
  const configHmrProtocol = typeof config.server.hmr === "object" ? config.server.hmr.protocol : null;
  const clientProtocol = configHmrProtocol ? (configHmrProtocol === "wss" ? "https" : "http") : null;
  const serverProtocol = config.server.https ? "https" : "http";
  const protocol = clientProtocol ?? serverProtocol;

  const configHmrHost = typeof config.server.hmr === "object" ? config.server.hmr.host : null;
  const configHost = typeof config.server.host === "string" ? config.server.host : null;
  const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address;
  const host = configHmrHost ?? configHost ?? serverAddress;

  const configHmrClientPort = typeof config.server.hmr === "object" ? config.server.hmr.clientPort : null;
  const port = configHmrClientPort ?? address.port;

  return `${protocol}://${host}:${port}`;
}

function isIpv6(address: AddressInfo): boolean {
  return (
    address.family === "IPv6" ||
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore-next-line
    address.family === 6
  );
}

/**
 * Resolve the server config from the environment.
 */
function resolveEnvironmentServerConfig(env: Record<string, string>):
  | {
      hmr?: { host: string };
      host?: string;
      https?: { cert: Buffer; key: Buffer };
    }
  | undefined {
  if (!env.VITE_DEV_SERVER_KEY && !env.VITE_DEV_SERVER_CERT) {
    return;
  }

  if (!fs.existsSync(env.VITE_DEV_SERVER_KEY) || !fs.existsSync(env.VITE_DEV_SERVER_CERT)) {
    throw Error(
      `Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`,
    );
  }

  const host = resolveHostFromEnv(env);

  if (!host) {
    throw Error(`Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`);
  }

  return {
    hmr: { host },
    host,
    https: {
      key: fs.readFileSync(env.VITE_DEV_SERVER_KEY),
      cert: fs.readFileSync(env.VITE_DEV_SERVER_CERT),
    },
  };
}

/**
 * Resolve the host name from the environment.
 */
function resolveHostFromEnv(env: Record<string, string>): string | undefined {
  try {
    return new URL(env.APP_URL).host;
  } catch {
    return;
  }
}

/**
 * The directory of the current file.
 */
function dirname(): string {
  return fileURLToPath(new URL(".", import.meta.url));
}
