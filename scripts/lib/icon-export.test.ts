import { assert, describe, it } from "@effect/vitest";
import { Resvg } from "@resvg/resvg-js";
import {
  encodePngIco,
  IconExportSourceMissingError,
  portableIconSvg,
  readPngDimensions,
} from "./icon-export.ts";
const pngHeader = (width: number, height: number) => {
  const contents = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(contents);
  contents.write("IHDR", 12, "ascii");
  contents.writeUInt32BE(width, 16);
  contents.writeUInt32BE(height, 20);
  return contents;
};

describe("icon export", () => {
  it("reads dimensions from a PNG IHDR chunk", () => {
    assert.deepEqual(readPngDimensions(pngHeader(1024, 512)), { width: 1024, height: 512 });
  });

  it("encodes PNG renditions into an ICO directory", () => {
    const small = pngHeader(16, 16);
    const large = pngHeader(256, 256);
    const ico = encodePngIco([
      { size: 16, contents: small },
      { size: 256, contents: large },
    ]);

    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(22), 0);
    assert.equal(ico.readUInt32LE(18), 38);
    assert.equal(ico.readUInt32LE(34), 38 + small.length);
    assert.deepEqual(ico.subarray(38, 38 + small.length), small);
    assert.deepEqual(ico.subarray(38 + small.length), large);
  });

  it("rejects duplicate ICO rendition sizes", () => {
    assert.throws(
      () =>
        encodePngIco([
          { size: 32, contents: pngHeader(32, 32) },
          { size: 32, contents: pngHeader(32, 32) },
        ]),
      /provided more than once/,
    );
  });

  it("renders a non-blank raster from portableIconSvg with an embedded PNG layer", () => {
    const redPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const iconJson = JSON.stringify({
      groups: [
        {
          layers: [
            {
              "image-name": "layer.png",
              position: { scale: 8.5, "translation-in-points": [0, 0] },
            },
          ],
        },
      ],
    });
    const layerSources = new Map([["layer.png", redPng]]);
    const svg = portableIconSvg(iconJson, layerSources, false);
    assert.isTrue(svg.includes("data:image/png;base64,"));

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 64 } });
    const rendered = resvg.render();
    const dimensions = readPngDimensions(rendered.asPng());
    assert.deepEqual(dimensions, { width: 64, height: 64 });
    // Assert pixels are not blank / transparent (the dropped layer bug produced 0 alpha/RGB)
    const pixels = rendered.pixels;
    assert.isTrue(pixels.length === 64 * 64 * 4);
    const centerOffset = (32 * 64 + 32) * 4;
    assert.isTrue((pixels[centerOffset] ?? 0) > 100, "expected red channel to be rendered");
    assert.isTrue((pixels[centerOffset + 3] ?? 0) > 100, "expected alpha channel to be rendered");
  });

  it("throws IconExportSourceMissingError when a layer source is missing", () => {
    const iconJson = JSON.stringify({
      groups: [
        {
          layers: [{ "image-name": "missing.png" }],
        },
      ],
    });
    let thrown: unknown;
    try {
      portableIconSvg(iconJson, new Map(), false);
    } catch (error) {
      thrown = error;
    }
    assert.instanceOf(thrown, IconExportSourceMissingError);
    assert.equal((thrown as IconExportSourceMissingError).sourcePath, "missing.png");
  });
});
