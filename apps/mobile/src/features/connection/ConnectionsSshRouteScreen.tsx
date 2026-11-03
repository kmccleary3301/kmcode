import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { mobileSshNative } from "../../connection/nativeSsh";
import { connectSsh } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { NativeStackScreenOptions } from "../../native/StackHeader";

type ConnectionsSshParams = {
  readonly host?: string;
  readonly port?: string;
  readonly username?: string;
};

export function ConnectionsSshRouteScreen({
  route,
}: StaticScreenProps<ConnectionsSshParams | undefined>) {
  const navigation = useNavigation();
  const connect = useAtomCommand(connectSsh);
  const params = route.params ?? {};
  const [alias, setAlias] = useState(params.host ?? "");
  const [host, setHost] = useState(params.host ?? "");
  const [port, setPort] = useState(params.port ?? "22");
  const [username, setUsername] = useState(params.username ?? "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [inspectedFingerprint, setInspectedFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const inspect = useCallback(async () => {
    const trimmedHost = host.trim();
    const numericPort = Number(port);
    if (!trimmedHost || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
      Alert.alert(
        "Check SSH details",
        "Enter a host and a valid port before inspecting the host key.",
      );
      return;
    }
    setBusy(true);
    try {
      const result = await mobileSshNative.inspectHost(trimmedHost, numericPort);
      setInspectedFingerprint(result.fingerprint);
      setFingerprint("");
    } catch (error) {
      Alert.alert(
        "SSH host inspection failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusy(false);
    }
  }, [host, port]);

  const submit = useCallback(async () => {
    const trimmedHost = host.trim();
    const trimmedUser = username.trim();
    const numericPort = Number(port);
    if (
      !alias.trim() ||
      !trimmedHost ||
      !trimmedUser ||
      !Number.isInteger(numericPort) ||
      numericPort < 1 ||
      numericPort > 65535
    ) {
      Alert.alert("Check SSH details", "Alias, host, username, and a valid port are required.");
      return;
    }
    if (!inspectedFingerprint || fingerprint.trim() !== inspectedFingerprint) {
      Alert.alert(
        "Confirm the host key",
        "Inspect this host and enter the exact SHA-256 fingerprint shown before connecting.",
      );
      return;
    }
    if (!password && !privateKey.trim()) {
      Alert.alert("SSH authentication required", "Enter a password or a private key.");
      return;
    }
    setBusy(true);
    try {
      const result = await connect({
        target: {
          alias: alias.trim(),
          hostname: trimmedHost,
          username: trimmedUser,
          port: numericPort,
        },
        credentials: {
          password: password || undefined,
          privateKey: privateKey.trim() || undefined,
          passphrase: passphrase || undefined,
          expectedFingerprint: inspectedFingerprint,
        },
      });
      if (AsyncResult.isSuccess(result)) {
        navigation.goBack();
      } else if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "SSH connection failed",
          error instanceof Error ? error.message : "The environment could not be connected.",
        );
      }
    } catch (error) {
      Alert.alert("SSH connection failed", error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    alias,
    connect,
    fingerprint,
    host,
    inspectedFingerprint,
    navigation,
    passphrase,
    password,
    port,
    privateKey,
    username,
  ]);
  const field = (
    label: string,
    value: string,
    onChangeText: (value: string) => void,
    options?: {
      readonly secureTextEntry?: boolean;
      readonly keyboardType?: "default" | "numeric";
      readonly multiline?: boolean;
      readonly numberOfLines?: number;
    },
  ) => (
    <View className="gap-1.5">
      <Text className="text-sm font-t3-medium text-foreground">{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!busy}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={options?.secureTextEntry}
        keyboardType={options?.keyboardType}
        multiline={options?.multiline}
        numberOfLines={options?.numberOfLines}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-xl border border-input-border bg-input px-3 py-2.5 text-foreground"
      />
    </View>
  );

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          ...(Platform.OS === "android" ? { headerShown: false } : null),
          title: "Add SSH Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Add SSH Environment" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView contentContainerClassName="gap-4 p-5" keyboardShouldPersistTaps="handled">
        <Text className="text-sm text-foreground-muted">
          The SSH host needs Node.js and an installed compatible t3 server. Server packages are not
          downloaded automatically.
        </Text>
        {field("Alias", alias, setAlias)}
        {field("Host", host, (value) => {
          setHost(value);
          setInspectedFingerprint(null);
          setFingerprint("");
        })}
        {field(
          "Port",
          port,
          (value) => {
            setPort(value);
            setInspectedFingerprint(null);
            setFingerprint("");
          },
          { keyboardType: "numeric" },
        )}
        {field("Username", username, setUsername)}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Inspect SSH host key"
          disabled={busy}
          onPress={() => void inspect()}
          className="rounded-xl border border-border px-4 py-3 active:opacity-70"
        >
          <Text className="text-center font-t3-medium text-foreground">
            {busy ? "Inspecting…" : "Inspect host key"}
          </Text>
        </Pressable>
        {inspectedFingerprint ? (
          <View className="gap-2 rounded-xl border border-border bg-card p-3">
            <Text className="text-sm text-foreground-muted">SHA-256 fingerprint</Text>
            <Text selectable className="font-t3-medium text-foreground">
              {inspectedFingerprint}
            </Text>
            {field("Enter fingerprint to confirm", fingerprint, setFingerprint)}
          </View>
        ) : null}
        {field("Password (optional with private key)", password, setPassword, {
          secureTextEntry: true,
        })}
        {field("Private key (optional with password)", privateKey, setPrivateKey, {
          multiline: true,
          numberOfLines: 6,
        })}
        {field("Key passphrase (optional)", passphrase, setPassphrase, { secureTextEntry: true })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect SSH environment"
          disabled={busy}
          onPress={() => void submit()}
          className="rounded-xl bg-primary px-4 py-3 active:opacity-70"
        >
          <Text className="text-center font-t3-medium text-primary-foreground">
            {busy ? "Connecting…" : "Connect"}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
