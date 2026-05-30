# Leeche RV Nano Tool

CLI helper for downloading, flashing, and doing first-boot setup for a LicheeRV Nano SD card.

The first version is intentionally conservative:

- it downloads known LicheeRV Nano image assets from GitHub releases
- it lists removable/external disks before flashing
- it refuses to flash a disk unless you type an exact confirmation phrase
- it rejects internal disks when macOS/Linux can identify them
- it configures the booted board over SSH instead of trying to mutate Linux partitions from macOS

## Requirements

- Node.js 20 or newer
- macOS or Linux for direct SD card flashing
- `xz` for `.img.xz` files
- `lz4` for `.img.lz4` files
- `ssh` for post-boot configuration

On macOS with Homebrew:

```sh
brew install xz lz4
```

Check the host:

```sh
npm run doctor
```

## Quick Start

Run the CLI directly from the repo:

```sh
node src/cli.js doctor
node src/cli.js sources
node src/cli.js images --source official
node src/cli.js disks
```

Download the latest official Sipeed image:

```sh
node src/cli.js download --source official --out images
```

Flash a downloaded image to the SD card:

```sh
node src/cli.js flash --image images/2025-12-30-20-00-6073d5.img.xz --disk /dev/disk4
```

Or download and flash in one step:

```sh
node src/cli.js prepare --source official --disk /dev/disk4
```

Before writing anything, the tool prints the target disk and asks you to type:

```text
FLASH /dev/disk4
```

Use the disk path from your own `node src/cli.js disks` output. Do not copy a disk path from this README.

## Image Sources

Current built-in sources:

| Source | Description | Upstream |
| --- | --- | --- |
| `official` | Sipeed official Buildroot images | <https://github.com/sipeed/LicheeRV-Nano-Build> |
| `debian` | Community Debian images | <https://github.com/scpcom/sophgo-sg200x-debian> |
| `ubuntu` | Community Ubuntu images | <https://github.com/Z841973620/licheervnano-ubuntu> |

The official flashing docs are here:

<https://wiki.sipeed.com/hardware/en/lichee/RV_Nano/4_burn_image.html>

List known sources:

```sh
node src/cli.js sources
```

List releases for a source:

```sh
node src/cli.js images --source debian
node src/cli.js images --source ubuntu
```

Download a specific release asset:

```sh
node src/cli.js download --source debian --asset licheervnano --out images
```

## First-Boot Configuration

After flashing, insert the SD card into the LicheeRV Nano, boot it, find its IP address, then configure over SSH.

Examples:

```sh
node src/cli.js configure \
  --host root@192.168.1.50 \
  --hostname licheerv-nano \
  --authorized-key ~/.ssh/id_ed25519.pub \
  --timezone America/Los_Angeles
```

Wi-Fi setup writes `/etc/wpa_supplicant.conf` on the device. Put the password in an environment variable so it does not appear in shell history:

```sh
export LEECHE_WIFI_PASSWORD='your-password'
node src/cli.js configure \
  --host root@192.168.1.50 \
  --wifi-ssid 'your-network'
```

Preview the SSH command without running it:

```sh
node src/cli.js configure --host root@192.168.1.50 --hostname licheerv-nano --dry-run
```

## Commands

```text
leeche-rv-nano doctor
leeche-rv-nano sources
leeche-rv-nano images [--source official] [--limit 10]
leeche-rv-nano download [--source official] [--tag latest] [--asset NAME] [--out images]
leeche-rv-nano disks
leeche-rv-nano prepare --disk /dev/diskN [--source official] [--tag latest] [--asset NAME]
leeche-rv-nano flash --image PATH --disk /dev/diskN
leeche-rv-nano configure --host root@IP [--hostname NAME] [--authorized-key PATH] [--timezone TZ]
```

If installed globally later, the binary name is:

```sh
leeche-rv-nano
```

For now, run `node src/cli.js ...` from this repo.

## Safety Model

Flashing an OS image overwrites the entire target disk. This tool has guardrails, but it cannot know your intent better than you can.

The `flash` and `prepare` commands:

- require a whole-disk `/dev/...` target
- print image size and disk size
- reject internal disks by default
- unmount the target before writing
- ask for an exact `FLASH <disk>` confirmation
- eject or sync the disk after writing

On macOS, the tool writes to `/dev/rdiskN` for speed after validating `/dev/diskN`.

## Development

Run syntax and smoke checks:

```sh
node --check src/cli.js
npm run doctor
npm run images -- --source official --limit 3
```

No third-party runtime dependencies are used yet. That keeps the first version easy to audit before we add UI, image customization, or board-specific provisioning.

## Next Work

Likely next additions:

- checksum/signature verification when upstream publishes checksum assets
- a TUI or browser UI for safer disk/image selection
- first-boot files for images that expose a writable boot partition
- board-specific setup profiles for camera, networking, packages, users, SSH keys, and services
- release packaging so the CLI can be installed with one command
