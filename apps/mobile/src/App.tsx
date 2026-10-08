import Constants from "expo-constants";
import { PermissionUpdateNotice } from "./components/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { Button, SafeAreaView, StatusBar, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";
import { RegistryContext } from "@effect/atom-react";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import {
  MobilePreferencesStore,
  type MobilePreferencesSaveError,
  type Preferences,
} from "./persistence/mobile-preferences";
import { mobilePreferencesAtom } from "./state/preferences";
import {
  createMobileAppearanceRestorePatch,
  parseMobileAppearanceRecoveryUrl,
  resetMobileAppearance,
  type MobileAppearanceRecoveryAction,
} from "./lib/mobileAppearanceRecovery";
import { runtime } from "./lib/runtime";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const configuredSchemes = Constants.expoConfig?.scheme;
const configuredAppScheme =
  (Array.isArray(configuredSchemes) ? configuredSchemes[0] : configuredSchemes) || "t3code";

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  filter: (url: string) =>
    shouldHandleAppLink(url) && parseMobileAppearanceRecoveryUrl(url, configuredAppScheme) === null,
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  const [recoveryAction, setRecoveryAction] = useState<
    MobileAppearanceRecoveryAction | "safe-continued" | "loading" | "normal"
  >("loading");
  useEffect(() => {
    let active = true;
    let receivedRecoveryUrl = false;
    const openRecoveryUrl = (url: string | null | undefined) => {
      const action = parseMobileAppearanceRecoveryUrl(url, configuredAppScheme);
      if (action === null) return false;
      receivedRecoveryUrl = true;
      setRecoveryAction(action);
      return true;
    };
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (active) openRecoveryUrl(url);
    });
    void Linking.getInitialURL()
      .then((url) => {
        if (active && !receivedRecoveryUrl && !openRecoveryUrl(url)) {
          setRecoveryAction("normal");
        }
      })
      .catch(() => {
        if (active && !receivedRecoveryUrl) setRecoveryAction("normal");
      });
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      {recoveryAction === "loading" ? null : recoveryAction === "safe" ? (
        <AppearanceRecoverySurface
          action="safe"
          onComplete={() => setRecoveryAction("safe-continued")}
        />
      ) : recoveryAction === "reset" ? (
        <AppearanceRecoverySurface
          action="reset"
          onComplete={() => setRecoveryAction("safe-continued")}
          onCancel={() => setRecoveryAction("normal")}
        />
      ) : (
        <CloudAuthProvider>
          <AppearancePreferencesProvider skipPortableProfile={recoveryAction === "safe-continued"}>
            <AppContent />
          </AppearancePreferencesProvider>
        </CloudAuthProvider>
      )}
    </RegistryContext.Provider>
  );
}

function AppearanceRecoverySurface(props: {
  readonly action: MobileAppearanceRecoveryAction;
  readonly onComplete: () => void;
  readonly onCancel?: () => void;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [restoreConfirming, setRestoreConfirming] = useState(false);
  const current: Preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : {};

  useEffect(() => {
    void SplashScreen.hide();
  }, []);

  const persist = async (
    operation: (
      store: MobilePreferencesStore["Service"],
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>,
  ) => {
    setIsSaving(true);
    try {
      await runtime.runPromise(MobilePreferencesStore.pipe(Effect.flatMap(operation)));
      setIsSaving(false);
      return true;
    } catch {
      setIsSaving(false);
      setSaveError("The appearance recovery change could not be saved. Try again.");
      return false;
    }
  };

  const confirm = async () => {
    if (props.action === "reset") {
      if (!(await persist(resetMobileAppearance))) return;
    }
    props.onComplete();
  };

  const restore = async () => {
    const quarantinedProfile = current.quarantinedAppearanceProfile;
    if (quarantinedProfile === undefined) return;
    if (
      !(await persist((store) =>
        store.savePatch(
          createMobileAppearanceRestorePatch(current.appearanceProfile, quarantinedProfile),
        ),
      ))
    ) {
      return;
    }
    props.onComplete();
  };

  return (
    <SafeAreaView style={recoveryStyles.container}>
      <View style={recoveryStyles.card}>
        <Text style={recoveryStyles.title}>
          {props.action === "safe" ? "Appearance recovery" : "Reset appearance?"}
        </Text>
        <Text style={recoveryStyles.message}>
          {props.action === "safe"
            ? "Custom appearance is disabled for this launch. Continue with the built-in appearance."
            : "Your current portable appearance will be moved to quarantine. You can restore it later."}
        </Text>
        <Button
          title={props.action === "safe" ? "Continue with built-in appearance" : "Reset appearance"}
          onPress={() => void confirm()}
          disabled={isSaving}
        />
        {props.action === "safe" && current.quarantinedAppearanceProfile !== undefined ? (
          <Button
            title={
              restoreConfirming
                ? "Confirm restore quarantined appearance"
                : "Restore quarantined appearance"
            }
            onPress={() => {
              if (restoreConfirming) void restore();
              else setRestoreConfirming(true);
            }}
            disabled={isSaving}
          />
        ) : null}
        {saveError === null ? null : <Text style={recoveryStyles.error}>{saveError}</Text>}
        {props.action === "reset" && props.onCancel !== undefined ? (
          <Button title="Cancel" onPress={props.onCancel} disabled={isSaving} />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const recoveryStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f1ea" },
  card: { flex: 1, justifyContent: "center", gap: 16, padding: 24 },
  title: { color: "#2b211b", fontSize: 24, fontWeight: "700" },
  message: { color: "#66554a", fontSize: 16, lineHeight: 24 },
  error: { color: "#b42318", fontSize: 15, lineHeight: 22 },
});

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
              <GlobalVoiceInputControl>
                <IncomingShareProvider>
                  <Navigation linking={appLinking} theme={navigationTheme} />
                </IncomingShareProvider>
                <ConfirmDialogHost />
                <ThreadArrangementHost />
              </GlobalVoiceInputControl>
              {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
