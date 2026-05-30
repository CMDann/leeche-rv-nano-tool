export const imageSources = {
  official: {
    label: "Sipeed official Buildroot images",
    owner: "sipeed",
    repo: "LicheeRV-Nano-Build",
    assetPattern: /\.(img|img\.xz|img\.lz4)$/i,
    docs: "https://wiki.sipeed.com/hardware/en/lichee/RV_Nano/4_burn_image.html"
  },
  debian: {
    label: "Community Debian images",
    owner: "scpcom",
    repo: "sophgo-sg200x-debian",
    assetPattern: /licheervnano.*_sd\.img\.lz4$/i,
    docs: "https://github.com/scpcom/sophgo-sg200x-debian/"
  },
  ubuntu: {
    label: "Community Ubuntu images",
    owner: "Z841973620",
    repo: "licheervnano-ubuntu",
    assetPattern: /licheervnano.*\.img\.xz$/i,
    docs: "https://github.com/Z841973620/licheervnano-ubuntu"
  }
};

export function sourceNames() {
  return Object.keys(imageSources);
}

export function getSource(name) {
  const source = imageSources[name];
  if (!source) {
    throw new Error(`Unknown image source "${name}". Valid sources: ${sourceNames().join(", ")}`);
  }
  return source;
}
