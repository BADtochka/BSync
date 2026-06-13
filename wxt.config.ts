import preact from "@preact/preset-vite";
import { defineConfig } from "wxt";

export default defineConfig({
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: ({ browser }) => ({
    name: "BSync",
    description: "Interactive browser sync overlay built with WXT and Preact.",
    permissions: ["storage", "tabs"],
    action: {
      default_title: "BSync",
    },
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* wss://*;",
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              data_collection_permissions: {
                required: ["none" as const],
              },
            },
          },
        }
      : {}),
  }),
  hooks: {
    "build:manifestGenerated"(wxt, manifest) {
      if (wxt.config.browser !== "firefox" || wxt.config.manifestVersion !== 3)
        return;

      if (Array.isArray(manifest.web_accessible_resources)) {
        for (const resource of manifest.web_accessible_resources) {
          if (typeof resource === "object" && resource !== null) {
            delete (resource as { use_dynamic_url?: boolean }).use_dynamic_url;
          }
        }
      }

      const csp = manifest.content_security_policy;
      if (typeof csp === "object" && csp !== null) {
        delete (csp as { sandbox?: string }).sandbox;
      }
    },
  },
});
