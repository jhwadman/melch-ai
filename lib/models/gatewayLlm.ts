/**
 * lib/models/gatewayLlm.ts — the one-key fallback, as an ADK BaseLlm.
 *
 * WHY this file exists:
 *   The transport's work is GatewayAdapter (lib/models/gatewayAdapter.ts),
 *   on the engine's own model contract: any cloud model id through a hosted
 *   gateway's chat-completions endpoint when the provider's direct key is
 *   absent (lib/models/gateway.ts owns that decision), attributed to the
 *   upstream provider, with every native tool dropped and reported. ADK
 *   still runs every turn, so this class runs the adapter under ADK: it is
 *   the chat-completions shim (lib/models/openAiCompatibleLlm.ts, ADR 0057).
 *   The constructor is what it was before the adapter moved onto the
 *   contract, so lib/models/registry.ts and every caller are unchanged.
 *
 * Registration: LLMRegistry keys on regex OBJECTS, so a gateway class must
 * carry the SAME supportedModels instances as the direct adapter it stands
 * in for (see gatewayClassFor below, and its use in registry.ts).
 */

import { requireAdk } from '../adkPeer.ts';

import { GatewayAdapter } from './gatewayAdapter.ts';
import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

export class GatewayLlm extends OpenAiCompatibleLlm {
  /** Never registered directly — see gatewayClassFor(). */
  static readonly supportedModels: Array<string | RegExp> = [];

  /** The gateway (MODEL_GATEWAY and its key) is read from the environment when constructed. */
  constructor({ model }: { model: string }) {
    super(new GatewayAdapter({ model }), { model });
  }
}

/**
 * A GatewayLlm subclass that answers for the given model patterns. Pass the
 * direct adapter's OWN `supportedModels` array so the registry entry
 * REPLACES that adapter's (the dict is keyed by regex object) rather than
 * adding a second, shadowed match.
 */
export function gatewayClassFor(patterns: Array<string | RegExp>): typeof GatewayLlm {
  return class GatewayLlmFor extends GatewayLlm {
    static override readonly supportedModels: Array<string | RegExp> = patterns;
  };
}

/** Registers a gateway stand-in for the given patterns. */
export function registerGatewayLlm(patterns: Array<string | RegExp>): void {
  requireAdk("Registering a model class with ADK's LLMRegistry").LLMRegistry.register(gatewayClassFor(patterns));
}
