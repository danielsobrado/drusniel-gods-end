export function assetUrl(path) {
  if (!path) return null;
  return new URL(path.replace(/^\/+/, ''), document.baseURI).toString();
}
