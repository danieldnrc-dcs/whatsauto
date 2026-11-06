// Small signature sniffing so the stored type does not depend only on what the sender claims.
export function fileTypeFromBuffer(b: Buffer): string | null {
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString("latin1") === s;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (at(1, "PNG")) return "image/png";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "%PDF")) return "application/pdf";
  if (at(0, "OggS")) return "audio/ogg";
  if (at(0, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (at(4, "ftyp")) return b.subarray(8, 12).toString("latin1").startsWith("M4A") ? "audio/mp4" : "video/mp4";
  return null;
}
