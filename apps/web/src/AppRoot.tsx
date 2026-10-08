import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { AppearanceCustomizationManager } from "./components/settings/AppearanceCustomizationManager";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

function browserAppearanceRecoveryRequest(): "safe" | "reset" | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("t3-appearance");
  return value === "safe" || value === "reset" ? value : null;
}

function leaveBrowserAppearanceRecovery(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("t3-appearance");
  window.location.replace(url);
}

function BrowserAppearanceRecoverySurface(props: { readonly action: "safe" | "reset" }) {
  return (
    <div
      data-t3-app
      data-t3-surface="route-appearance-recovery"
      style={{
        minHeight: "100%",
        overflow: "auto",
        background: "#ffffff",
        color: "#1f1f21",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <main style={{ boxSizing: "border-box", maxWidth: 960, margin: "0 auto", padding: 24 }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Appearance recovery</h1>
        <p style={{ maxWidth: 720, lineHeight: 1.5 }}>
          {props.action === "safe"
            ? "Custom appearance is disabled for this tab. Disable or delete the package or snippet that caused the failure, then reload the app."
            : "Reset removes saved appearance customizations after confirmation and keeps a recovery copy where the platform supports it."}
        </p>
        <AppearanceCustomizationManager />
        <button
          type="button"
          onClick={leaveBrowserAppearanceRecovery}
          style={{ marginTop: 24, padding: "8px 12px", cursor: "pointer" }}
        >
          Leave recovery and reload
        </button>
      </main>
    </div>
  );
}

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  const recoveryRequest = browserAppearanceRecoveryRequest();
  if (recoveryRequest !== null) {
    return <BrowserAppearanceRecoverySurface action={recoveryRequest} />;
  }
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
