import { defineConfig } from 'wxt';

const firefoxExtensionId = process.env.FIREFOX_EXTENSION_ID || process.env.WXT_FIREFOX_EXTENSION_ID;

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser }) => ({
    name: 'BSync',
    description: 'Interactive browser sync overlay built with WXT and React.',
    permissions: ['storage', 'tabs', 'notifications'],
    action: {
      default_title: 'BSync',
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' ws://localhost:* wss://*;",
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: firefoxExtensionId,
              data_collection_permissions: {
                required: ['none' as const],
              },
            },
          },
        }
      : {}),
  }),
  hooks: {
    'build:manifestGenerated'(wxt, manifest) {
      if (wxt.config.browser !== 'firefox' || wxt.config.manifestVersion !== 3) return;

      if (Array.isArray(manifest.web_accessible_resources)) {
        for (const resource of manifest.web_accessible_resources) {
          if (typeof resource === 'object' && resource !== null) {
            delete (resource as { use_dynamic_url?: boolean }).use_dynamic_url;
          }
        }
      }

      const csp = manifest.content_security_policy;
      if (typeof csp === 'object' && csp !== null) {
        delete (csp as { sandbox?: string }).sandbox;
      }
    },
  },
});
