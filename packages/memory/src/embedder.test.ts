// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { NoopEmbedder } from "./embedder.js";

describe("NoopEmbedder", () => {
  it("embeds to an empty vector (Phase 0 lexical-only seam)", async () => {
    const embedder = new NoopEmbedder();
    await expect(embedder.embed("anything at all")).resolves.toEqual([]);
    await expect(embedder.embed("")).resolves.toEqual([]);
  });
});
