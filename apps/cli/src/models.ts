// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx models list` — the declared model catalog from the provider registry.
// Offline by construction: hosted providers report exactly the models
// declared in nyx.config.yaml (never a network call — that probe belongs to
// `nyx doctor`), and the mock provider reports its standard mock-1 entry.

import type { NyxConfig } from "@nyx/config";
import { MockProvider } from "@nyx/model";
import type { ModelInfo } from "@nyx/protocol";
import { renderTable } from "./table.js";

export interface ModelRow {
  provider: string;
  model: ModelInfo;
}

export interface ModelsListing {
  rows: ModelRow[];
  /** Providers with no declared models (a hosted provider queried live would
   * be a network call — `nyx doctor` owns that probe). */
  empty: string[];
}

/** List declared models per provider. Pure config read: no I/O, no network. */
export async function listDeclaredModels(config: NyxConfig): Promise<ModelsListing> {
  const rows: ModelRow[] = [];
  const empty: string[] = [];
  for (const [id, entry] of Object.entries(config.providers)) {
    let models: ModelInfo[];
    if (entry.kind === "mock") {
      models = await new MockProvider(id, []).listModels();
    } else {
      models = entry.models;
    }
    if (models.length === 0) {
      empty.push(id);
      continue;
    }
    for (const model of models) rows.push({ provider: id, model });
  }
  return { rows, empty };
}

/** Render `nyx models list` as a table (+ notes for empty providers). */
export function renderModels(listing: ModelsListing): string {
  const lines: string[] = [];
  lines.push(
    renderTable(
      ["provider", "model", "context", "max_output", "supports"],
      listing.rows.map((r) => [
        r.provider,
        r.model.id,
        String(r.model.context_window),
        String(r.model.max_output),
        r.model.supports.join(","),
      ]),
    ),
  );
  for (const id of listing.empty) {
    lines.push(`note ${id}: no models declared in config (run "nyx doctor" for a live probe)`);
  }
  return lines.join("\n");
}
