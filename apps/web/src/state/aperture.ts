import { createApertureEnvironmentAtoms } from "@t3tools/client-runtime/state/aperture";

import { connectionAtomRuntime } from "../connection/runtime";

export const apertureEnvironment = createApertureEnvironmentAtoms(connectionAtomRuntime);
