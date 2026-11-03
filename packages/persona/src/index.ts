// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/persona — loads a persona directory and assembles the system prompt
// deterministically, in the fixed section order defined by @nyx/protocol.

export { PersonaSchema, loadPersona, PersonaLoadError } from "./persona.js";
export type { PersonaConfig, LoadedPersona } from "./persona.js";
export { PersonaRuntimeImpl, BASE_PREAMBLE, assemblePromptText } from "./runtime.js";
export { SECTION_ORDER } from "@nyx/protocol";
export type {
  PersonaRuntime,
  PromptAssemblyInput,
  PromptSection,
  SectionId,
} from "@nyx/protocol";
