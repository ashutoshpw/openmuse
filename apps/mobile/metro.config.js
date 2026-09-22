const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

const configuredResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith(".js")) {
    const directPath = path.resolve(path.dirname(context.originModulePath), moduleName);
    const sourcePath = directPath.slice(0, -3);
    if (
      !fs.existsSync(directPath) &&
      [".ts", ".tsx"].some((extension) => fs.existsSync(`${sourcePath}${extension}`))
    ) {
      const resolveRequest = configuredResolveRequest ?? context.resolveRequest;
      return resolveRequest(context, moduleName.slice(0, -3), platform);
    }
  }
  const resolveRequest = configuredResolveRequest ?? context.resolveRequest;
  return resolveRequest(context, moduleName, platform);
};

module.exports = config;
