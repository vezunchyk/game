// Папка тайла -> ВИД тайла (за map-src/folder-kinds.json). Один код для всіх будинків.

/** Ланцюжок імен папок тайла: від найглибшої до кореня. */
export function folderChain(tile, folderById) {
  const names = [];
  for (let id = tile.folderId, n = 0; id && n < 32; n++) {
    const f = folderById.get(id);
    if (!f) break;
    names.push(f.name);
    id = f.parentId;
  }
  return names;
}

/** { kind, kindFolder, interior, shade, chain } — kind = '' якщо жодна папка не відома. */
export function classifyTile(tile, folderById, cfg) {
  const chain = folderChain(tile, folderById);
  let kind = "", kindFolder = "";
  for (const name of chain) {
    if (cfg.kinds[name]) { kind = cfg.kinds[name]; kindFolder = name; break; } // найглибша виграє
  }
  const interior = chain.some((n) => (cfg.interior || []).includes(n));
  let shade = "";
  for (const name of chain) {
    if ((cfg.shade.light || []).includes(name)) { shade = "light"; break; }
    if ((cfg.shade.dark || []).includes(name)) { shade = "dark"; break; }
  }
  const axisless = chain.some((n) => (cfg.axisless || []).includes(n));
  return { kind, kindFolder, interior, shade, axisless, chain };
}
