import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

/**
 * Sign files with matching options together instead of spawning codesign for each file.
 *
 * An unsigned build is signed ad hoc, so macOS ties its Keychain access to that
 * build's hash and asks again for the Safe Storage key after every rebuild.
 * `T3CODE_DESKTOP_MAC_LOCAL_SIGN_IDENTITY` names a local identity with a team ID
 * (an Apple Development certificate is enough) to sign those builds with
 * instead: Keychain access then follows the team, so one "Always Allow" lasts.
 */
export default async function sign(options: SignOptions): Promise<void> {
  const localIdentity = process.env.T3CODE_DESKTOP_MAC_LOCAL_SIGN_IDENTITY?.trim();
  await signApplication({
    ...options,
    ...(options.identity === "-" && localIdentity ? { identity: localIdentity } : {}),
    batchCodesignCalls: true,
  });
}
