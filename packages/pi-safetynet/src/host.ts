/**
 * host.ts — publish pi-safetynet's cooperation surface (SafetynetHost) on the
 * extension event bus so pi-submarine (installed separately, loaded in its own
 * module graph) can run its children under safetynet's permission engine and
 * follow the live mode state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishSafetynetHost, type SafetynetHost } from "pi-submarine-core";
import { getModeAliases, getParadigm, getCurrentProfile } from "../core/profiles.ts";
import { loadTrustExternalPaths } from "../core/global-config.ts";
import type { PermissionStorage } from "../core/permissions/index.ts";
import { createSafetynetChildServices } from "./child-services.ts";

/** Build the host around the parent session's live state. */
export function buildSafetynetHost(api: ExtensionAPI, storage: PermissionStorage): SafetynetHost {
	return {
		kind: "safetynet",
		getProfile: () => getCurrentProfile(),
		getParadigm: () => getParadigm(),
		getModeAliases: () => getModeAliases(),
		trustExternalPaths: () => loadTrustExternalPaths() || api.getFlag("trust-external-paths") === true,
		childServices: createSafetynetChildServices(storage),
	};
}

/** Publish the host; returns the unsubscriber. */
export function announceSafetynetHost(api: ExtensionAPI, storage: PermissionStorage): () => void {
	return publishSafetynetHost(api.events, buildSafetynetHost(api, storage));
}