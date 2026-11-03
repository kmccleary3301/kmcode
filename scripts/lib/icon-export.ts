import * as Schema from "effect/Schema";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const WINDOWS_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export interface PngIconImage {
  readonly size: number;
  readonly contents: Buffer;
}

export function readPngDimensions(contents: Buffer): {
  readonly width: number;
  readonly height: number;
} {
  if (
    contents.length < 24 ||
    !contents.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Icon Composer produced an invalid PNG.");
  }

  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

/** Encodes PNG renditions directly into a modern, multi-resolution ICO file. */
export function encodePngIco(images: ReadonlyArray<PngIconImage>): Buffer {
  if (images.length === 0) {
    throw new Error("An ICO file requires at least one PNG rendition.");
  }

  const seenSizes = new Set<number>();
  for (const image of images) {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`ICO rendition size must be an integer from 1 to 256, got ${image.size}.`);
    }
    if (seenSizes.has(image.size)) {
      throw new Error(`ICO rendition size ${image.size} was provided more than once.`);
    }
    if (image.contents.length === 0) {
      throw new Error(`ICO rendition ${image.size}x${image.size} is empty.`);
    }
    seenSizes.add(image.size);
  }

  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = directoryEntrySize * images.length;
  const header = Buffer.alloc(headerSize + directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = header.length;
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * directoryEntrySize;
    const encodedSize = image.size === 256 ? 0 : image.size;
    header.writeUInt8(encodedSize, entryOffset);
    header.writeUInt8(encodedSize, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.contents.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.contents.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.contents)]);
}
export class IconExportSourceMissingError extends Schema.TaggedError<IconExportSourceMissingError>()(
  "IconExportSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing Icon Composer source project: ${this.sourcePath}`;
  }
}

export const PortableIconLayer = Schema.Struct({
  "image-name": Schema.String,
  opacity: Schema.optional(Schema.Number),
  hidden: Schema.optional(Schema.Boolean),
  position: Schema.optional(
    Schema.Struct({
      scale: Schema.optional(Schema.Number),
      "translation-in-points": Schema.optional(Schema.Tuple([Schema.Number, Schema.Number])),
    }),
  ),
});

export const decodePortableIconProject = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      groups: Schema.Array(Schema.Struct({ layers: Schema.Array(PortableIconLayer) })),
    }),
  ),
);

export function portableIconSvg(
  iconJson: string,
  layerSources: ReadonlyMap<string, Buffer>,
  safeArea: boolean,
): string {
  const project = decodePortableIconProject(iconJson);
  const layers = project.groups
    .flatMap((group) => group.layers)
    .toReversed()
    .filter((layer) => !layer.hidden);
  const fill = "#171411";
  const inset = safeArea ? 100 : 0;
  const bodySize = safeArea ? 824 : 1024;
  const children = layers.flatMap((layer) => {
    const source = layerSources.get(layer["image-name"]);
    if (source === undefined) {
      throw new IconExportSourceMissingError({ sourcePath: layer["image-name"] });
    }
    const isPng = layer["image-name"].endsWith(".png");
    const mime = isPng ? "image/png" : "image/svg+xml";
    const encoded = source.toString("base64");
    const scale = (layer.position?.scale ?? 8.5) / 8.5;
    const translation = layer.position?.["translation-in-points"] ?? [0, 0];
    const translateX = (translation[0] * bodySize) / 1024;
    const translateY = (translation[1] * bodySize) / 1024;
    return [
      `<image href="data:${mime};base64,${encoded}" x="${inset}" y="${inset}" width="${bodySize}" height="${bodySize}" opacity="${layer.opacity ?? 1}" transform="translate(${translateX} ${translateY}) scale(${scale})" preserveAspectRatio="none"/>`,
    ];
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><clipPath id="body-clip"><rect x="${inset}" y="${inset}" width="${bodySize}" height="${bodySize}" rx="${Math.round(bodySize * 0.22)}"/></clipPath></defs><rect x="${inset}" y="${inset}" width="${bodySize}" height="${bodySize}" rx="${Math.round(bodySize * 0.22)}" fill="${fill}"/><g clip-path="url(#body-clip)">${children.join("")}</g></svg>`;
}
