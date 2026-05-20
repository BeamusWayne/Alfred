import { registerCommand } from "./types.js";

let _authManager: import("../auth/manager.js").AuthManager | null = null;

export function setAuthManager(manager: import("../auth/manager.js").AuthManager): void {
  _authManager = manager;
}

export function loginCommand(): void {
  registerCommand({
    name: "login",
    description: "Login with API key: /login <provider> <key>",
    execute: async (args: string) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        return { type: "error", message: "Usage: /login <provider> <key>" };
      }
      const [provider, key] = parts;
      if (!_authManager) {
        return { type: "error", message: "Auth not configured" };
      }
      await _authManager.setKey(provider, key);
      return { type: "text", content: `Logged in to ${provider}` };
    },
  });
}

export function logoutCommand(): void {
  registerCommand({
    name: "logout",
    description: "Logout from a provider: /logout <provider>",
    execute: async (args: string) => {
      const provider = args.trim();
      if (!provider) {
        return { type: "error", message: "Usage: /logout <provider>" };
      }
      if (!_authManager) {
        return { type: "error", message: "Auth not configured" };
      }
      await _authManager.deleteKey(provider);
      return { type: "text", content: `Logged out from ${provider}` };
    },
  });
}
