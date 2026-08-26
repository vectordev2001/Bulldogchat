/**
 * Smoke test: featured tile in the speaker and sidebar layouts uses
 * `fit="contain"` so the primary speaker isn't cropped.
 *
 * PR #87 established `object-contain` as the default for Room.tsx's
 * large StageTile. CallVideoStage (used by CallOverlays) rendered the
 * focused tile with no `fit` prop, so CallTile's default kicked in and
 * a wide-aspect camera / portrait phone shot could be cropped.
 *
 * Grid layout stays on `cover` because tiles are equal-sized and
 * cropping is intentional there to align the grid.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stage = readFileSync(
  resolve(__dirname, "..", "client/src/components/call/CallVideoStage.tsx"),
  "utf8",
);

// Speaker layout: featured tile must pass fit="contain".
const speakerBlock = stage.slice(stage.indexOf('layout === "speaker"'));
const speakerFocusedFocused = speakerBlock.slice(0, speakerBlock.indexOf("rest.map"));
assert.ok(
  /<CallTile\s+\{\.\.\.focused\}\s+fit="contain"/.test(speakerFocusedFocused),
  'speaker layout must render `<CallTile {...focused} fit="contain" />`',
);

// Sidebar layout: featured tile must also pass fit="contain".
const sidebarBlock = stage.slice(stage.indexOf("// sidebar"));
const sidebarFocused = sidebarBlock.slice(0, sidebarBlock.indexOf("rest.map"));
assert.ok(
  /<CallTile\s+\{\.\.\.focused\}\s+fit="contain"/.test(sidebarFocused),
  'sidebar layout must render `<CallTile {...focused} fit="contain" />`',
);

// Non-featured tiles (grid tiles, filmstrip thumbs) must NOT force
// contain — they should stay on CallTile's default `cover` so
// equal-sized tiles align cleanly.
const nonFeaturedTiles = stage.match(/<CallTile\s+\{\.\.\.p\}[^/]*\/>/g) ?? [];
assert.ok(
  nonFeaturedTiles.length >= 2,
  `expected at least two non-featured <CallTile {...p} .../> tags, found ${nonFeaturedTiles.length}`,
);
for (const tag of nonFeaturedTiles) {
  assert.ok(
    !/fit="contain"/.test(tag),
    `non-featured tile must not override fit to contain: ${tag}`,
  );
}

console.log(
  'OK: CallVideoStage featured tile uses fit="contain" in speaker and sidebar layouts',
);
